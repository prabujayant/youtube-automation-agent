require('dotenv').config();
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

  const codeFlag = process.argv.indexOf('--code');
  const rawCode = codeFlag >= 0 ? process.argv[codeFlag + 1] : '';
  if (!rawCode) {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES
    });
    console.log('\n1. Open this URL while signed in to the channel owner account:\n');
    console.log(url);
    console.log('\n2. Approve access. The browser redirects to 127.0.0.1 and may show a connection error.');
    console.log('   Copy the code parameter from the address bar.\n');
    console.log('3. Exchange it with:\n');
    console.log('   npm run youtube:reauth -- --code "PASTE_CODE_OR_REDIRECT_URL_HERE"\n');
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
  console.log(`\nSaved config/tokens.json. Refresh token: ${expiry}`);
  console.log('\nUpdate the GitHub Actions secret:\n');
  console.log('  Get-Content config\\tokens.json -Raw | gh secret set YOUTUBE_TOKENS_JSON -R prabujayant/youtube-automation-agent\n');
})().catch(error => {
  console.error(`\nRe-authorization failed: ${error.message}`);
  process.exit(1);
});
