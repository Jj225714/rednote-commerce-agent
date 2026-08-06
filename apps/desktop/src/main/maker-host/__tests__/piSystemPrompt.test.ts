import { describe, expect, it } from 'vitest';

import { composePiSystemPrompt } from '../pi-host.js';
import hostSystemPrompt from '../host-system-prompt.md?raw';
import piSystemPrompt from '../pi-system-prompt.md?raw';

describe('composePiSystemPrompt', () => {
  it('keeps the shared identity first and appends the Pi language behavior', () => {
    const prompt = composePiSystemPrompt(
      'You are Cindy.',
      "Infer the user's primary language and use it for reasoning and user-facing content.",
    );

    expect(prompt).toBe(
      "You are Cindy.\n\nInfer the user's primary language and use it for reasoning and user-facing content.",
    );
  });

  it('trims sections and omits empty ones', () => {
    expect(composePiSystemPrompt('  You are Cindy.  ', '   ')).toBe('You are Cindy.');
  });

  it('keeps the shared Rednote safety boundary before the Pi language suffix exactly once', () => {
    const prompt = composePiSystemPrompt(hostSystemPrompt, piSystemPrompt);

    expect(prompt).toContain('You are Rednote Agent');
    expect(prompt).toContain('Only prepare a proposal');
    expect(prompt.match(/You are Rednote Agent/g)).toHaveLength(1);
    expect(prompt.indexOf('You are Rednote Agent')).toBeLessThan(
      prompt.indexOf("Infer the user's primary language"),
    );
  });
});
