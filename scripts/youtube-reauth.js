require('dotenv').config();
const path = require('path');
const { google } = require('googleapis');
const { CredentialManager } = require('../utils/credential-manager');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

function extractCode(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).searchParams.get('code') || '';
    } catch (_error) {
      return '';
    }
  }
  return value.replace(/^code=/, '').split('&')[0];
}

(async () => {
  const tokensFlag = process.argv.indexOf('--tokens');
  const tokensPath = tokensFlag >= 0 ? process.argv[tokensFlag + 1] : '';
  const credentials = new CredentialManager(tokensPath ? { tokensPath } : {});
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

  const codeFlag = process.argv.indexOf('--code');
  const rawCode = codeFlag >= 0 ? process.argv[codeFlag + 1] : '';
  if (!rawCode) {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES
    });
    console.log('\n1. Open this URL signed in to the Google account that owns the channel.\n   For a brand channel (e.g. Zentrox Clips), pick its account on the consent screen.\n');
    console.log(url);
    console.log('\n2. Approve access. The browser redirects to 127.0.0.1 and may show a connection error.');
    console.log('   Copy the code parameter from the address bar.\n');
    console.log('3. Exchange it with:\n');
    console.log('   npm run youtube:reauth -- --code "PASTE_CODE_OR_REDIRECT_URL_HERE"');
    console.log('   Add --tokens config/tokens.zentrox.json to authorize the second channel.\n');
    return;
  }

  const code = extractCode(rawCode);
  if (!code) throw new Error('No authorization code was found in --code');
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove this app from your Google Account permissions and run the flow again.');
  }

  credentials.tokens.youtube = tokens;
  await credentials.saveTokens();

  const expiry = tokens.refresh_token_expires_in
    ? `${Math.round(Number(tokens.refresh_token_expires_in) / 86400)} days (the app is still in Testing mode)`
    : 'no 7-day expiry (production token)';
  const relative = path.relative(path.join(__dirname, '..'), credentials.tokensPath).replace(/\\/g, '/');
  const secretName = /zentrox/i.test(credentials.tokensPath)
    ? 'YOUTUBE_TOKENS_ZENTROX_JSON'
    : 'YOUTUBE_TOKENS_JSON';
  console.log(`\nSaved ${relative}. Refresh token: ${expiry}`);
  console.log('\nUpdate the GitHub Actions secret:\n');
  console.log(`  Get-Content ${relative} -Raw | gh secret set ${secretName} -R prabujayant/youtube-automation-agent\n`);
  if (secretName === 'YOUTUBE_TOKENS_ZENTROX_JSON') {
    console.log('Then enable the second channel:\n');
    console.log('  gh variable set ZENTROX_ENABLED --body true -R prabujayant/youtube-automation-agent\n');
  }
})().catch(error => {
  console.error(`\nRe-authorization failed: ${error.message}`);
  process.exit(1);
});
