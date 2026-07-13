/**
 * Sprint 6.1 — Requirements Hub / Jira import.
 * Focused tests for adfToPlainText(), the pure helper that flattens Atlassian
 * Document Format (ADF) issue descriptions into plain text stored on the
 * requirement. This is the most heuristic new logic, so we pin its behavior.
 */
import { adfToPlainText } from '../../src/integrations/jira';

describe('adfToPlainText', () => {
  it('returns empty string for null/undefined', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
  });

  it('passes through plain strings unchanged', () => {
    expect(adfToPlainText('already plain')).toBe('already plain');
  });

  it('flattens paragraphs and headings', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Overview' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'A user can log in.' }] },
      ],
    };
    expect(adfToPlainText(adf)).toBe('Overview\nA user can log in.');
  });

  it('renders bullet lists with dashes', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }] },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe('- First\n- Second');
  });

  it('numbers ordered lists', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }] },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe('1. Alpha\n2. Beta');
  });

  it('handles hardBreak and inlineCard inline nodes', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See' },
            { type: 'hardBreak' },
            { type: 'inlineCard', attrs: { url: 'https://example.com/x' } },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe('See\nhttps://example.com/x');
  });

  it('indents nested lists', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
                {
                  type: 'bulletList',
                  content: [
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child' }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toBe('- Parent\n  - Child');
  });
});
