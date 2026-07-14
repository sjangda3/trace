# GitHub App setup

Trace uses GitHub App Device Flow. The downloadable desktop app ships a public client ID only; it never contains a client secret or private key.

## Register the app

Create a GitHub App owned by the product organization and configure it as follows:

- GitHub App name: your production product name
- Homepage URL: the product homepage
- Callback URL: not used by the desktop Device Flow
- Expire user authorization tokens: enabled
- Request user authorization during installation: enabled
- Device Flow: enabled
- Where can this GitHub App be installed?: Any account

Initial repository permissions:

- Metadata: read-only
- Issues: read-only
- Pull requests: read-only
- Contents: read-only only when immutable PR snapshots are added

Add write permissions only when publishing comments, resolving review threads, or updating issues is enabled in the product. Existing installations will need to approve the expanded permissions.

## Run a configured development build

Copy the public client ID and app slug from the GitHub App settings page, then launch Electron with:

```bash
TRACE_GITHUB_CLIENT_ID="Iv1.your-public-client-id" \
TRACE_GITHUB_APP_SLUG="your-app-slug" \
npm start
```

The client ID is public application metadata. Do not add a client secret, private key, user token, or refresh token to this repository or the renderer bundle.

## Credential boundary

- Device codes, access tokens, and refresh tokens stay in Electron main.
- Saved tokens are encrypted with Electron `safeStorage` and written atomically with `0600` permissions.
- The renderer receives only connection state, account identity, repository identity, and normalized GitHub data.
- Each authenticated response is discarded if the workspace's GitHub repository or opaque local repository key changed while the request was running.

## Production note

The GitHub App registration is external product infrastructure. A packaged build will show a setup-required state until its public client ID is supplied by the release configuration.
