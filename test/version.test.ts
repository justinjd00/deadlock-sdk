import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_AGENT, VERSION } from '../src';

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(DEFAULT_USER_AGENT).toContain(`deadlock-sdk/${VERSION}`);
  });
});
