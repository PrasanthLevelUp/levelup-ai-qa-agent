# JWT_SECRET Setup & Deployment Guide

> **TL;DR** — The session cookie is signed by the **backend API** and verified by
> **both** the backend and the **dashboard** (Next.js middleware). All services
> that sign or verify it **must share the exact same `JWT_SECRET`**. If they
> drift, users log in successfully but every authenticated request returns
> `401`, surfacing in the UI as *"Signed in, but your session could not be
> established."*

---

## 1. Root cause of the production login failure

The login flow is:

1. **Backend** (`levelup-ai-qa-agent`) `POST /api/auth/login` signs a JWT with
   `JWT_SECRET` and sets it as the `levelup_session` HTTP-only cookie.
2. The browser then calls `GET /api/auth/me`.
3. The **dashboard** (`levelup-ai-qa-dashboard`) `middleware.ts` intercepts that
   request and runs `jwtVerify(token, JWT_SECRET)` using **its own**
   `JWT_SECRET` before the request is ever proxied to the backend.

If the dashboard's `JWT_SECRET` does not match the backend's, step 3 throws and
returns `401 "Session expired"`. The cookie is present and valid — it just
can't be verified with a different key. This is exactly what the production
screenshot showed: `/api/auth/me` → `401 Unauthorized` with the cookie attached.

### Why it was invisible

Every service previously fell back to the **same hard-coded weak default**:

```ts
const JWT_SECRET = process.env.JWT_SECRET || 'levelup-jwt-secret-change-in-production';
```

So if `JWT_SECRET` was set on **one** service (e.g. the backend on Railway) but
**missing** on the other (e.g. the dashboard), the configured service used the
real secret while the other silently used the weak default — two different
secrets, no error, no log. Tokens minted by one could never be verified by the
other.

---

## 2. What the code change does

- **Single source of truth:** `src/config/auth.ts` is now the only place that
  reads `process.env.JWT_SECRET`. The auth route and the session/company
  middleware all import `JWT_SECRET` (and the cookie config) from it.
- **Fail fast in production:** if `JWT_SECRET` is unset or shorter than 32
  characters **and** `NODE_ENV === 'production'`, the process throws at startup
  instead of booting with the insecure default. A misconfigured deploy now
  crashes loudly at boot rather than silently serving un-verifiable tokens.
- **Dev stays easy:** outside production, a known fallback is still used, but it
  logs a loud `WARNING` so nobody ships it by accident.

> The code change makes the misconfiguration **impossible to ship silently**,
> but it cannot invent the secret for you — you still have to set the **same**
> `JWT_SECRET` on every service (next section).

---

## 3. Generate a strong secret

```bash
openssl rand -base64 48
# example output (use your own!):
# 9f2c1e7b4a6d8033c5e1f0ab27d94e6c8b1a5f3e0d7c2b9a4e6f1c8d3b0a7e5f
```

Use **one** generated value for **all** services. Do not generate a separate
secret per service.

---

## 4. Set it on every service

The session cookie crosses two deployments, so set the identical value on both.

### 4.1 Backend API — `levelup-ai-qa-agent` (Railway)

```bash
# Railway CLI
railway variables set JWT_SECRET="<paste-the-generated-value>"

# or: Railway dashboard → service → Variables → New Variable
#   Name:  JWT_SECRET
#   Value: <paste-the-generated-value>
```

Also confirm `NODE_ENV=production` is set (it must be, so the cookie is sent
with `Secure` and the fail-fast guard is active).

### 4.2 Dashboard — `levelup-ai-qa-dashboard` (Railway / Vercel)

Set the **same** `JWT_SECRET` value here too:

```bash
# Railway
railway variables set JWT_SECRET="<same-value-as-backend>"

# Vercel
vercel env add JWT_SECRET production    # paste the same value when prompted
```

> ⚠️ On Vercel, `middleware.ts` runs in the Edge runtime and reads
> `process.env.JWT_SECRET` at build/deploy time — **redeploy** the dashboard
> after adding or changing the variable for it to take effect.

### 4.3 Redeploy & verify

1. Redeploy **both** services after setting the variable.
2. Log in at the dashboard.
3. Confirm `GET /api/auth/me` returns `200` (not `401`) and the dashboard loads.

---

## 5. Deployment checklist

- [ ] Generated a strong secret with `openssl rand -base64 48` (≥ 32 chars).
- [ ] `JWT_SECRET` set on the **backend** (`levelup-ai-qa-agent`).
- [ ] `JWT_SECRET` set on the **dashboard** (`levelup-ai-qa-dashboard`) — **same value**.
- [ ] Value is **byte-for-byte identical** on both (watch for trailing spaces / newlines when pasting).
- [ ] `NODE_ENV=production` on both services.
- [ ] Both services **redeployed** after setting the variable.
- [ ] No hard-coded fallback relied on in production (the backend now refuses to boot without it).
- [ ] Verified end-to-end: login → `/api/auth/me` returns `200` → dashboard loads.
- [ ] Secret stored only in the platform's env/secret manager — **never** committed to git.

---

## 6. Rotating the secret

Rotating `JWT_SECRET` invalidates all existing sessions (every active user is
logged out). To rotate:

1. Generate a new secret.
2. Update it on **all** services at the same time.
3. Redeploy all services together to minimize the window where they disagree.
4. Users simply log in again.
