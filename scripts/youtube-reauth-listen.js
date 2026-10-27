require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');
const { CredentialManager } = require('../utils/credential-manager');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

(async () => {
  const credentials = new CredentialManager();
  await credentials.initialize();
  const youtube = credentials.credentials?.youtube;
  if (!youtube?.client_id || !youtube?.client_secret || !youtube?.redirect_uris?.[0]) {
    throw new Error('YouTube OAuth client is not configured. Run `npm run credentials:setup` first.');
  }

  const oauth2Client = new google.auth.OAuth2(
    youtube.client_id,
    youtube.client_secret,
    youtube.redirect_uris[0]
  );
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const error = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');
    if (!code && !error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Waiting</title><p>Waiting for Google authorization…</p>');
      return;
    }
    try {
      if (error) throw new Error(`Google returned ${error}`);
      const { tokens } = await oauth2Client.getToken(code);
      if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token');
      }
      credentials.tokens.youtube = tokens;
      await credentials.saveTokens();
      const expiry = tokens.refresh_token_expires_in
        ? `${Math.round(Number(tokens.refresh_token_expires_in) / 86400)} days (still in Testing mode)`
        : 'no 7-day expiry (production token)';
      console.log(`SUCCESS|${expiry}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Authorized</title><h1>Authorization complete</h1><p>${expiry}</p><p>You can close this tab.</p>`);
      setTimeout(() => process.exit(0), 1200);
    } catch (exchangeError) {
      console.error(`FAILED|${exchangeError.message}`);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Authorization failed</title><h1>Authorization failed</h1><p>${exchangeError.message}</p>`);
      setTimeout(() => process.exit(1), 1200);
    }
  });

  server.listen(80, '127.0.0.1', () => {
    console.log(`AUTH_URL|${authUrl}`);
    console.log('LISTENING|http://127.0.0.1');
  });
  server.on('error', error => {
    console.error(`LISTEN_FAILED|${error.code || error.message}`);
    process.exit(1);
  });
  setTimeout(() => {
    console.error('TIMEOUT|No callback after 15 minutes');
    process.exit(1);
  }, 15 * 60 * 1000).unref();
})().catch(error => {
  console.error(`FAILED|${error.message}`);
  process.exit(1);
});
