# Releasing & npm publishing

Deze repo publiceert **automatisch naar npm via GitHub Actions** met npm
**OIDC Trusted Publishing**. Géén npm-tokens, géén 2FA/OTP-codes, géén handmatige
`npm publish`. Dit is de enige ondersteunde route — wijk er niet van af.

> Waarom: de eigenaar logt in met een **passkey** en heeft geen TOTP/2FA-codes.
> Een handmatige `npm publish` loopt vast op een 2FA-muur. OIDC Trusted Publishing
> omzeilt dat volledig: de publish gebeurt in CI, zonder geheimen.

## Een nieuwe versie uitbrengen (de normale flow)

1. Zorg dat `main` groen is en alle wijzigingen erin staan.
2. Hoog de versie op en maak de tag (één commando):
   ```bash
   npm version patch        # of minor / major — past package.json aan + maakt tag vX.Y.Z
   git push origin main --follow-tags
   ```
3. Voeg vooraf een `#### [X.Y.Z]`-sectie toe aan `CHANGELOG.md` (de release-notes
   worden daaruit gehaald).
4. De **Release**-workflow (`.github/workflows/release.yml`) draait op de tag:
   lint → test → build → GitHub Release uit CHANGELOG → `npm publish --provenance`
   via OIDC. Klaar. npm werkt zichzelf bij, zonder verdere handelingen.

**Nooit** met de hand `npm publish` draaien. **Nooit** een npm-token of OTP-code gebruiken.

## Eenmalig per NIEUW pakket (bootstrap)

npm vereist dat een pakket **al bestaat** voordat OIDC het kan overnemen: een
Trusted Publisher koppel je op de package-settings-pagina, en die bestaat pas ná
de eerste publish (bevestigd in npm's docs; een OIDC-publish van een onbestaand
pakket geeft `404 Not Found`). Daarom is de allereerste publish van een nieuw
pakket **één keer handmatig** — daarna nooit meer.

**Stap 1 — eerste publish, op een machine met echte terminal + browser** (bv. de
desktop waar de passkey werkt; NIET de headless server, die kan de passkey-flow niet):

```bash
git clone <repo-url>
cd <repo>
npm install
npm publish --access public      # opent de browser → bevestig met passkey. Geen token, geen code.
```

**Stap 2 — Trusted Publisher koppelen** (nu de package-pagina bestaat):

- npmjs.com → het pakket → **Settings** → **Trusted Publisher** → **GitHub Actions**
  - **Organization or user:** `SanderBaron`
  - **Repository:** de repo-naam
  - **Workflow filename:** `release.yml`
  - **Environment:** *(leeg laten)*

Vanaf dat moment publiceert elke `vX.Y.Z`-tag volledig automatisch via de workflow —
geen handmatige publish meer.

## Een nieuwe plugin opzetten met deze methode

Kopieer `.github/workflows/release.yml`, zorg voor een `files`-whitelist in
`package.json` (alleen `dist`, UI-map, `config.schema.json`, docs), en doe de
eenmalige Trusted-Publisher-koppeling hierboven. Verder identiek.
