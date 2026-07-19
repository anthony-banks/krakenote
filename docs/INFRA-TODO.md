# Infra TODO

Deferred infrastructure work. Product backlog lives in [`PRD.md`](PRD.md).

---

## Apex `krakenote.com` deep links 404 — PARKED (2026-07-19)

**Status:** deliberately deferred. Not blocking. Code side is done and merged-ready in PR #6.

### Symptom

| URL | Result |
|---|---|
| `www.krakenote.com/*` | 200 ✅ |
| `krakenote.com/` | 301 → www ✅ |
| `krakenote.com/anything` | **404** ❌ |

### Cause

The apex resolves to GoDaddy's domain-forwarding service (`3.33.251.168`, `15.197.225.128`),
which only carries the **root** path. Deep-link requests never reach Railway, so no
server-side change can fix it alone.

### Why it's parked

Nothing links to bare-apex deep paths — `sitemap.xml` and all canonical tags point at
`www`, so search engines only index the working hostname. The 404 is reachable only by
hand-typing or sharing a bare-apex path.

**Deferring costs nothing technically** — the migration is identical whenever it's done.
The only thing that grows is the blast radius of a mistake, since the domain now carries
live email. Do this *before* promoting any apex URL (campaign link, QR code, print).

### Blocker

Railway issues a **CNAME** for the apex (`h0ge4o3f.up.railway.app`). DNS forbids a CNAME
at a zone root, and GoDaddy supports no ALIAS/ANAME/flattening. So fixing this requires
moving DNS hosting to a provider that flattens root CNAMEs. Cloudflare's Free plan does,
at no cost. Domain *registration* stays at GoDaddy either way.

### Runbook

Full zone as read from live DNS on 2026-07-19. Verify Cloudflare's importer against this
table — importers routinely drop records, and **MX is the one that matters**.

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `@` | `h0ge4o3f.up.railway.app` | **DNS only** |
| CNAME | `www` | `vfkoalnd.up.railway.app` | **DNS only** |
| TXT | `_railway-verify` | `railway-verify=38cd57d5ac6ed7d4fb08ef5e5d…` (get full value from Railway) | — |
| MX | `@` | `mx1.improvmx.com` (priority 10) | — |
| MX | `@` | `mx2.improvmx.com` (priority 20) | — |
| TXT | `@` | `v=spf1 include:spf.improvmx.com ~all` | — |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | — |

Order matters — this sequence never leaves mail exposed:

1. Add the domain in Cloudflare (Free plan), let it import, **diff against the table above**.
2. Set both Railway CNAMEs to **DNS only** (grey cloud). Orange-cloud proxying in front of
   Railway breaks TLS unless SSL mode is Full/Strict — not worth the complication.
3. Copy the **full** `_railway-verify` TXT value from Railway (Settings → Networking →
   `krakenote.com` → Show DNS records). A truncated value fails verification.
4. Only now: switch nameservers at GoDaddy (currently `ns11`/`ns12.domaincontrol.com`) to
   the pair Cloudflare provides.
5. **Delete the GoDaddy Forwarding rule.** Easy to forget once nameservers move, and it is
   the actual source of the 404.
6. Merge PR #6 if not already merged.

**Rollback:** point the nameservers back at GoDaddy. Restores the current state, subject to
propagation delay.

### Verify after propagation

```bash
curl -sS -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://krakenote.com/anything
# want: 301 -> https://www.krakenote.com/anything

curl -sS -o /dev/null -w "%{http_code}\n" https://www.krakenote.com/privacy   # want 200
curl -sS https://www.krakenote.com/healthz                                    # want {"ok":true,...}
dig +short MX krakenote.com                                                   # want both improvmx hosts
```

Then send a real test message through the ImprovMX-forwarded address. Mail is the check
people skip and regret — nothing visibly errors when it breaks.

---

## Admin dashboard follow-ups (from PR #5) — not started

- `server/index.js` — the login client is built with `SUPABASE_SERVICE_ROLE_KEY` for
  `signInWithPassword`. Works, and the key stays server-side, but the **anon** key is the
  correct one for user auth; service-role here means a bug in that path fails open with
  maximum privilege.
- `server/index.js` — both waitlist reads are capped at `.limit(500)` with no indication.
  Past 500 signups the CSV "export" silently becomes a partial export.
