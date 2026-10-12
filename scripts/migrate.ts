import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.getMigrator();
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(
          applied.length
            ? `Aplicadas: ${applied.map((m) => m.name).join(', ')}`
            : 'Nada a aplicar',
        );
        break;
      }
      case 'down': {
        const reverted = await migrator.down();
        console.log(
          reverted.length
            ? `Revertidas: ${reverted.map((m) => m.name).join(', ')}`
            : 'Nada a reverter',
        );
        break;
      }
      case 'pending': {
        const pending = await migrator.getPendingMigrations();
        console.log(
          pending.length
            ? pending.map((m) => m.name).join('\n')
            : 'Nenhuma pendente',
        );
        break;
      }
      default:
        throw new Error(`Comando desconhecido: ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
