import {
  analyzeLocatorState,
  parseSelectorSignature,
  detectActiveOverlay,
} from '../../src/core/locator-state-analyzer';

describe('parseSelectorSignature', () => {
  it('parses an #id selector', () => {
    expect(parseSelectorSignature('#login-button')).toEqual({ kind: 'id', value: 'login-button' });
  });

  it('parses a .class selector', () => {
    expect(parseSelectorSignature('.submit-btn')).toEqual({ kind: 'class', value: 'submit-btn' });
  });

  it('parses a [data-test="x"] attribute selector', () => {
    expect(parseSelectorSignature('[data-test="login"]')).toEqual({
      kind: 'attr',
      name: 'data-test',
      value: 'login',
    });
  });

  it('parses an unquoted [data-test=x] attribute selector', () => {
    expect(parseSelectorSignature('[data-test=login]')).toEqual({
      kind: 'attr',
      name: 'data-test',
      value: 'login',
    });
  });

  it('parses getByTestId(...)', () => {
    expect(parseSelectorSignature("page.getByTestId('login')")).toEqual({
      kind: 'testid',
      value: 'login',
    });
  });

  it('parses a bare tag selector', () => {
    expect(parseSelectorSignature('button')).toEqual({ kind: 'tag', name: 'button' });
  });

  it('returns unknown for empty selector', () => {
    expect(parseSelectorSignature('')).toEqual({ kind: 'unknown' });
  });
});

describe('analyzeLocatorState — degraded (no snapshot)', () => {
  it('returns source=unknown when no DOM snapshot is available', () => {
    const st = analyzeLocatorState('#login-button', null);
    expect(st.source).toBe('unknown');
    expect(st.clickable).toBe(false);
  });
});

describe('analyzeLocatorState — existence', () => {
  it('reports !exists when the element is absent', () => {
    const html = '<html><body><div id="other"></div></body></html>';
    const st = analyzeLocatorState('#login-button', html);
    expect(st.exists).toBe(false);
    expect(st.clickable).toBe(false);
    expect(st.source).toBe('dom_snapshot');
  });

  it('reports exists/visible/enabled/clickable for a normal element', () => {
    const html = '<html><body><button id="login-button">Login</button></body></html>';
    const st = analyzeLocatorState('#login-button', html);
    expect(st.exists).toBe(true);
    expect(st.visible).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.receivesPointerEvents).toBe(true);
    expect(st.clickable).toBe(true);
  });
});

describe('analyzeLocatorState — visibility & enablement', () => {
  it('reports !visible for display:none', () => {
    const html = '<button id="login-button" style="display:none">Login</button>';
    const st = analyzeLocatorState('#login-button', html);
    expect(st.exists).toBe(true);
    expect(st.visible).toBe(false);
    expect(st.clickable).toBe(false);
  });

  it('reports !visible for aria-hidden', () => {
    const html = '<button id="login-button" aria-hidden="true">Login</button>';
    const st = analyzeLocatorState('#login-button', html);
    expect(st.visible).toBe(false);
  });

  it('reports !enabled for disabled', () => {
    const html = '<button id="login-button" disabled>Login</button>';
    const st = analyzeLocatorState('#login-button', html);
    expect(st.exists).toBe(true);
    expect(st.visible).toBe(true);
    expect(st.enabled).toBe(false);
    expect(st.clickable).toBe(false);
  });
});

describe('analyzeLocatorState — pointer interception (the canonical case)', () => {
  it('reports clickable=false when a loading overlay is present', () => {
    const html = `
      <html><body>
        <button id="login-button">Login</button>
        <div class="loading-overlay">Loading…</div>
      </body></html>`;
    const st = analyzeLocatorState('#login-button', html);
    // exists ✔ visible ✔ enabled ✔ clickable ✖ (covered by overlay)
    expect(st.exists).toBe(true);
    expect(st.visible).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.receivesPointerEvents).toBe(false);
    expect(st.clickable).toBe(false);
    expect(st.interceptedBy).toMatch(/overlay/i);
  });

  it('reports clickable=false for pointer-events:none on the element', () => {
    const html = '<button id="login-button" style="pointer-events:none">Login</button>';
    const st = analyzeLocatorState('#login-button', html);
    expect(st.receivesPointerEvents).toBe(false);
    expect(st.clickable).toBe(false);
    expect(st.interceptedBy).toMatch(/pointer-events/i);
  });

  it('does NOT flag an overlay that is display:none', () => {
    const html = `
      <button id="login-button">Login</button>
      <div class="modal-backdrop" style="display:none"></div>`;
    const st = analyzeLocatorState('#login-button', html);
    expect(st.clickable).toBe(true);
    expect(st.interceptedBy).toBeNull();
  });
});

describe('detectActiveOverlay', () => {
  it('detects a spinner overlay', () => {
    expect(detectActiveOverlay('<div class="spinner-mask"></div>')).toMatch(/spinner/i);
  });

  it('returns null when no overlay-like element exists', () => {
    expect(detectActiveOverlay('<div class="content"></div>')).toBeNull();
  });
});
