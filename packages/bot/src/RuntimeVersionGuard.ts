import fs from 'fs';
import path from 'path';

export interface RuntimeVersionStatus {
  requiredNodeVersion: string;
  actualNodeVersion: string;
  matches: boolean;
}

export function readRequiredNodeVersion(rootDirectory = path.resolve(__dirname, '..', '..', '..')): string {
  const nvmrcPath = path.join(rootDirectory, '.nvmrc');
  return fs.readFileSync(nvmrcPath, 'utf8').trim();
}

export function checkRuntimeVersion(
  actualNodeVersion: string,
  requiredNodeVersion: string,
): RuntimeVersionStatus {
  return {
    requiredNodeVersion,
    actualNodeVersion,
    matches: actualNodeVersion === `v${requiredNodeVersion}` || actualNodeVersion === requiredNodeVersion,
  };
}

export function assertRequiredNodeVersion(
  actualNodeVersion = process.version,
  requiredNodeVersion = readRequiredNodeVersion(),
): RuntimeVersionStatus {
  const status = checkRuntimeVersion(actualNodeVersion, requiredNodeVersion);
  if (!status.matches) {
    throw new Error(
      `[RUNTIME_GUARD] requiredNodeVersion=${status.requiredNodeVersion} ` +
        `actualNodeVersion=${status.actualNodeVersion} — refusing to start`,
    );
  }
  return status;
}
