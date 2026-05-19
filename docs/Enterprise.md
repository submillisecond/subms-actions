# Enterprise

What the action suite supports for environments behind proxies, with mTLS,
private CAs, OIDC, audit requirements, or PII concerns. **Soft-fail by
default; opt-in for stricter behaviour.**

## Networking

### Corporate HTTP/HTTPS proxy

The `subms-action-diff-sink` action's Node HTTP client honours the standard
`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` env vars. Authenticated proxies
(`http://user:pass@proxy:3128`) are supported via inline credentials.

```yaml
- uses: submillisecond/subms-action-diff-sink@v1
  env:
    HTTPS_PROXY: http://user:pass@proxy.internal:3128
    NO_PROXY: ".internal.example.com,10.0.0.0/8"
  with:
    input: subms-diff.json
    sink: datadog
    datadog-api-key: ${{ secrets.DATADOG_API_KEY }}
```

`NO_PROXY` entries match by exact hostname or `.suffix.com` rule. The
HTTPS path uses the standard CONNECT-tunnel pattern most corporate
proxies implement.

### Custom CA bundle

For corporate root CAs, set either of:

```yaml
env:
  NODE_EXTRA_CA_CERTS: /etc/ssl/certs/corp-root.pem    # Node's standard
  SUBMS_CA_BUNDLE:     /etc/ssl/certs/corp-root.pem    # equivalent override
```

The CA bundle is merged with Node's default trust store.

### Mutual TLS (client certs)

For sinks that require mTLS:

```yaml
env:
  SUBMS_CLIENT_CERT: /etc/ssl/certs/client.crt
  SUBMS_CLIENT_KEY:  /etc/ssl/private/client.key
```

PEM-encoded files only; PKCS12 is not supported (convert with
`openssl pkcs12 -in cert.p12 -out cert.crt -nokeys`).

### Air-gapped runners

All actions are pure Node std-lib / composite-bash. No `npm install`, no
network access for the actions themselves. The sink action only reaches out
to whatever endpoints you configure (`webhook-url`, `s3-url`, etc.).

For air-gapped enterprises:
- Use only `file` / `stdout` sinks, or `s3` against an internal MinIO/Ceph
- Vendor `subms-actions` into your internal mirror (the repo is small and
  has no transitive deps)

## Reliability

### Retry with exponential backoff

Built into `subms-action-diff-sink` and `subms-action-bench`. Defaults:

```yaml
env:
  SUBMS_RETRY_MAX:        "3"      # max retries
  SUBMS_RETRY_BASE_MS:    "500"    # initial backoff
  SUBMS_SINK_TIMEOUT_MS:  "30000"  # per-request timeout
```

Retryable: HTTP 408, 429, 5xx, ECONNRESET, ETIMEDOUT, EAI_AGAIN, ENOTFOUND,
ECONNREFUSED, "socket hang up". Backoff is `base * 2^attempt` with up to
half-base jitter, capped at 30s.

### Sink isolation

Multi-sink dispatch (`sink: "slack,s3,datadog"`) isolates per-sink failure.
One bad webhook doesn't stop the others. Per-sink success/failure is
reported in the action's `sink` and `failed-sinks` outputs.

## Security

### Action SHA pinning

The composite actions reference transitive `actions/*` with full commit
SHAs (`actions/upload-artifact@26f96dfa6...`, `actions/github-script@60a0d8...`)
plus `# v4.3.0` comments for human readability. This satisfies enterprise
supply-chain audit requirements (no floating tags = no silent action
rewrites).

When publishing your own fork or vendored copy, audit and re-pin SHAs to
your trusted snapshots.

### Secret hygiene

All credential inputs (`*-api-key`, `*-token`, `*-url` containing presigned
secrets) should come from `${{ secrets.X }}`, never inline. The reusable
workflow uses `workflow_call` secrets, so cross-repo usage flows secrets
through declared inputs and not the global env.

### PII scrubbing

`subms-action-diff-sink` redacts tag values matching configurable regex patterns
before payloads leave the runner:

```yaml
env:
  SUBMS_PII_SCRUB: |
    [\w.+-]+@[\w.-]+            # email addresses
    (\d{1,3}\.){3}\d{1,3}       # IPv4
    (?:\d{4}[- ]?){3}\d{4}      # credit-card-shaped strings
```

Newline-separated regexes (preferred) or a JSON array. Matches become
`[REDACTED]`. Patterns are global (`/g` flag) and applied to every tag
value passed via `TAGS` and to the action's built-in `workload` / `lang`
tags.

This is intentionally explicit: there's no auto-PII heuristic. You decide
what looks like PII for your data.

### Bench-result tamper-evidence (deferred)

A future release will sign the emitted JSON via HMAC (`SUBMS_SIGNING_KEY`
secret) so downstream sinks can verify the payload wasn't modified in
transit. Tracked as task #N (see CHANGELOG).

## Authentication

### OIDC for cloud sinks (no long-lived secrets)

For S3/GCS/Azure sinks, presigned URLs work in any environment but require
a step that generates them. Generating with OIDC + short-lived AWS/GCP/Azure
credentials avoids storing long-lived keys.

#### AWS S3 via OIDC

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/CIPerfPublisher
      aws-region: us-east-1

  - name: Generate presigned PUT URL
    id: presign
    run: |
      URL=$(aws s3 presign s3://my-bucket/perf/${{ github.sha }}.json --expires-in 600)
      echo "url=$URL" >> "$GITHUB_OUTPUT"

  - uses: submillisecond/subms-action-diff-sink@v1
    with:
      input: subms-diff.json
      sink: s3
      s3-url: ${{ steps.presign.outputs.url }}
```

#### GCS via Workload Identity Federation

```yaml
permissions:
  id-token: write

steps:
  - uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: projects/123/locations/global/workloadIdentityPools/ci/providers/github
      service_account: perf-publisher@my-project.iam.gserviceaccount.com

  - id: presign
    run: |
      URL=$(gcloud storage sign-url gs://my-bucket/perf/${{ github.sha }}.json \
        --duration=10m --http-verb=PUT --format='value(signed_url)')
      echo "url=$URL" >> "$GITHUB_OUTPUT"

  - uses: submillisecond/subms-action-diff-sink@v1
    with:
      input: subms-diff.json
      sink: gcs
      gcs-url: ${{ steps.presign.outputs.url }}
```

#### Azure Blob via Federated Identity

```yaml
permissions:
  id-token: write

steps:
  - uses: azure/login@v2
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

  - id: presign
    run: |
      SAS=$(az storage blob generate-sas \
        --account-name myaccount --container-name perf \
        --name ${{ github.sha }}.json \
        --permissions cw --expiry $(date -u -d '10 minutes' +%Y-%m-%dT%H:%MZ) -o tsv)
      echo "url=https://myaccount.blob.core.windows.net/perf/${{ github.sha }}.json?$SAS" >> "$GITHUB_OUTPUT"

  - uses: submillisecond/subms-action-diff-sink@v1
    with:
      input: subms-diff.json
      sink: azure
      azure-url: ${{ steps.presign.outputs.url }}
```

### HashiCorp Vault

If your secrets live in Vault, use [hashicorp/vault-action](https://github.com/hashicorp/vault-action)
to fetch them before the sink step:

```yaml
- uses: hashicorp/vault-action@v3
  with:
    url: https://vault.internal
    method: jwt
    role: ci-perf
    secrets: |
      kv/data/perf/slack webhook_url | SLACK_WEBHOOK ;
      kv/data/perf/datadog api_key   | DATADOG_API_KEY

- uses: submillisecond/subms-action-diff-sink@v1
  with:
    input: subms-diff.json
    sink: "slack,datadog"
    webhook-url:     ${{ env.SLACK_WEBHOOK }}
    datadog-api-key: ${{ env.DATADOG_API_KEY }}
```

## Compliance

### Audit trail

Every action emits a JSON artifact recording inputs + decision:
- `subms-action-diff` → `subms-diff.json` (incl. thresholds + verdict)
- `subms-action-diff-aggregate` → `subms-diff-aggregate.json` (incl. per-component status)
- `subms-action-drift` → `subms-drift.json` (incl. history-count + sigmas)
- `subms-action-diff-sink` → exit code + `pushed` / `failed-sinks` outputs

For SOC2 / ISO27001 audits, keep these artifacts past your retention
policy. The standard pattern is to upload them to immutable storage
(versioned S3 bucket with object lock) via the `s3` sink.

### Stable status-check names for branch protection

Each action publishes a fixed step name; the matrix-aware aggregator
publishes a single `aggregate / subms-action-diff-aggregate` check. Use this as
the required check in your branch protection rules:

```text
Required status checks:
  - perf / aggregate
  - perf / drift            (optional)
```

### CODEOWNERS-aware mentions

The shared `post-sticky-comment.js` helper accepts a `mentions` array.
Derive owners from CODEOWNERS in a preceding step and pass them in:

```yaml
- name: Resolve perf-owner from CODEOWNERS
  id: owners
  uses: actions/github-script@v7
  with:
    script: |
      const { execSync } = require('node:child_process');
      const owners = execSync('git ls-files | xargs grep -l "")  // adapt to your CODEOWNERS schema
      return { mentions: ['perf-team'] };

- uses: submillisecond/subms-action-diff@v1
  with: ...
  # The sticky-comment helper will append `@perf-team` to the PR comment.
```

(A first-class CODEOWNERS lookup is on the roadmap; for now use this
pattern.)

## Policy-as-code (preview)

A future release will read a single `.subms.yml` file at the repo root
declaring thresholds, sinks, and drift policy:

```yaml
# .subms.yml (preview - tracked as task #N)
default:
  threshold-pct: 15
  fail-on-regression: true
  per-stage-thresholds:
    get_miss: 25
    estimate: 50
sinks:
  - type: slack
    only-on-regression: true
    webhook-secret: SLACK_PERF_WEBHOOK
drift:
  history-glob: "perf-history/*.json"
  k-stddev: 3
  window-size: 30
```

The action(s) will read this once and apply the rules uniformly across
the matrix, removing the need to copy threshold inputs across N workflow
steps.

## GitHub Enterprise Server

All actions use composite + Node-native paths and the standard
`actions/*` SHA-pinned references. They work on GHES without changes
provided the `actions/github-script` / `actions/upload-artifact` /
`actions/download-artifact` / `actions/checkout` versions are mirrored
on your GHES instance.

For self-hosted runners, ensure Node 20+ is available (the actions all
use `node:fs`, `node:http`, `node:https`, `node:tls`, `node:child_process`,
`node:crypto`, `node:url`, `node:path`).

## Cost-aware retention

Sinks that persist data (S3 / GCS / Azure / InfluxDB / Splunk) accumulate
storage. Recommended bucket lifecycle:

- Hot tier: last 30 days of perf JSONs
- Warm tier: 30-365 days (Glacier / Coldline / Archive)
- Drop: > 365 days unless legal hold

The pre-signed URL pattern means lifecycle policy is enforced by the
storage provider, not the action.

## What's NOT supported (yet)

| feature | status |
|---|---|
| Bench-result HMAC signing | roadmap |
| `.subms.yml` policy-as-code | roadmap |
| First-class CODEOWNERS lookup | roadmap |
| PagerDuty / OpsGenie sinks | roadmap |
| Slack thread continuation (reply in thread vs new msg) | roadmap |
| Datadog event-stream sink (not just metrics) | roadmap |
| New Relic Logs / Honeycomb traces | roadmap |
| SLSA / SBOM provenance attestation | roadmap |
| Multi-window drift (1d / 7d / 30d concurrent) | roadmap |
| Bench-result diff between arbitrary refs (not just base ref) | roadmap |

PRs welcome.
