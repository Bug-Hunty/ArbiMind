/** EVM is inactive only when both scanner and trading are explicitly disabled. */
export function readEvmSubsystemState(env: NodeJS.ProcessEnv = process.env): {
  scannerEnabled: boolean;
  tradingEnabled: boolean;
  enabled: boolean;
} {
  const isFalse = (value: string | undefined): boolean => {
    let normalized = (value ?? '').trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) normalized = normalized.slice(1, -1).trim();
    return ['false', '0', 'no', 'off'].includes(normalized.toLowerCase());
  };
  const scannerEnabled = !isFalse(env['EVM_SCANNER_ENABLED']);
  const tradingEnabled = !isFalse(env['EVM_TRADING_ENABLED']);
  return { scannerEnabled, tradingEnabled, enabled: scannerEnabled || tradingEnabled };
}
