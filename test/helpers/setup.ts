import { setDefaultTimeout } from 'bun:test';

export function useRealInfraTimeouts(): void {
  setDefaultTimeout(60_000);
}
