import { Migration } from '@mikro-orm/migrations';

export class Migration20260731000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(18,2) NOT NULL,
        version INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets (id),
        player_id UUID NOT NULL,
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        reference_transaction_id UUID REFERENCES wager_transactions (id),
        failure_code TEXT,
        observed_balance NUMERIC(18,2),
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        reference_retry_count INT NOT NULL DEFAULT 0,
        reference_next_retry_at TIMESTAMPTZ,
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_provider_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE reference_external_transaction_id IS NOT NULL;
    `);
    this.addSql(`
      CREATE INDEX idx_wager_tx_pending_reference_due
        ON wager_transactions (reference_next_retry_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_reversal_once
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED'
          AND reference_transaction_id IS NOT NULL
          AND kind IN ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      CREATE INDEX idx_wager_tx_wallet ON wager_transactions (wallet_id);
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets (id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions (id),
        direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(18,2) NOT NULL CHECK (balance_before >= 0),
        balance_after NUMERIC(18,2) NOT NULL CHECK (balance_after >= 0),
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
          OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
        )
      );
    `);
    this.addSql(`
      CREATE INDEX idx_ledger_wallet_cursor
        ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries é imutável (append-only)';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );
    `);
    this.addSql(`
      CREATE INDEX idx_outbox_pending
        ON outbox_messages (occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql(
      'DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;',
    );
    this.addSql('DROP FUNCTION IF EXISTS forbid_ledger_mutation();');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
