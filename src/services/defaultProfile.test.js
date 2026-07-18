// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bootstrapDefaultProfile } from './defaultProfile';

const snapshot = {
  version: 1,
  layout: {
    pagesConfig: { header: [], pages: ['home'], home: ['light.salon'] },
  },
  appearance: { theme: 'dark' },
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('bootstrapDefaultProfile', () => {
  it('applies the file-backed profile on a new browser', async () => {
    const result = await bootstrapDefaultProfile({
      enabled: true,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'maison',
          templateVersion: 1,
          data: snapshot,
        }),
      }),
    });

    expect(result.applied).toBe(true);
    expect(JSON.parse(localStorage.getItem('tunet_pages_config'))).toEqual(
      snapshot.layout.pagesConfig
    );
  });

  it('never overwrites an existing browser dashboard', async () => {
    localStorage.setItem(
      'tunet_pages_config',
      JSON.stringify({ header: [], pages: ['home'], home: ['existing.card'] })
    );
    const fetchImpl = vi.fn();

    const result = await bootstrapDefaultProfile({ enabled: true, fetchImpl });

    expect(result).toEqual({ applied: false, reason: 'existing-dashboard' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
