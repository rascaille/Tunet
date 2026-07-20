// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readDefaultProfile } from '../defaultProfile.js';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('readDefaultProfile', () => {
  it('loads a standard Tunet dashboard export', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tunet-default-profile-'));
    tempDirs.push(directory);
    const filePath = join(directory, 'maison.json');

    writeFileSync(
      filePath,
      JSON.stringify({
        format: 'tunet-dashboard-export',
        version: 1,
        data: {
          version: 1,
          layout: { pagesConfig: { header: [], pages: ['home'], home: [] } },
          appearance: { theme: 'dark' },
        },
      })
    );

    expect(
      readDefaultProfile({ env: { TUNET_DEFAULT_PROFILE_FILE: filePath } })
    ).toMatchObject({
      id: 'maison',
      name: 'Maison',
      templateVersion: 1,
      data: { version: 1 },
    });
  });

  it('rejects files which are not Tunet snapshots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tunet-default-profile-'));
    tempDirs.push(directory);
    const filePath = join(directory, 'maison.json');
    writeFileSync(filePath, JSON.stringify({ hello: 'world' }));

    expect(() =>
      readDefaultProfile({ env: { TUNET_DEFAULT_PROFILE_FILE: filePath } })
    ).toThrow('valid Tunet snapshot');
  });
});
