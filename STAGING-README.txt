DERIV EA BOT: isolated OFFLINE staging addon

Place staging/, railway.json, and the three files in dashboard/ into
C:\Users\DELL\Desktop\Deriv-EA-Bot-Staging, replacing only the three
matching dashboard files. Do not copy into your original Deriv-EA-Bot folder.

This preview has NO Deriv connection, API token, account state or trades.
Do not use npm start or node bot.js. The only permitted staging startup is:
  node staging/server.js

Local PowerShell test (run in Deriv-EA-Bot-Staging):
  $env:STAGING_DASHBOARD_ONLY="true"
  $env:DASHBOARD_PASSWORD=Read-Host "Choose a new dashboard password (16+ characters)"
  node staging/server.js

Open http://localhost:8787 and sign in with the password you chose.
Stop the server with Ctrl+C. Do not post the password or screenshot of it.

For future ISOLATED Railway project ONLY (never existing production service):
  source branch: staging/read-only-dashboard
  start command: node staging/server.js (railway.json in branch)
  variables: STAGING_DASHBOARD_ONLY=true, DASHBOARD_PASSWORD=(strong unique 16+ chars)
  Do not add DERIV_API_TOKEN or connect to the production project/service.
  Inspect the deployment config before deploying to confirm its start command.

The dashboard shows an offline blank fixture: no account, balance, trades,
or market data. This only tests UI, login and server routes; it does not
test real Deriv connectivity or trading execution.
