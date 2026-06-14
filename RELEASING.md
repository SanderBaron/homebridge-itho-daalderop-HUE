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

OIDC kan een pakket pas publiceren als er een **Trusted Publisher** aan gekoppeld is.
Dit doe je één keer op npmjs.com (passkey-login werkt in een normale browser op
een desktop/telefoon — niet nodig op de headless server):

1. npmjs.com → ingelogd → een Trusted Publisher toevoegen voor de pakketnaam
   (een nog niet bestaand pakket mag; het wordt bij de eerste OIDC-publish aangemaakt).
2. Vul in:
   - **Publisher:** GitHub Actions
   - **Organization or user:** `SanderBaron`
   - **Repository:** de repo-naam (bv. `homebridge-itho-daalderop-HUE`)
   - **Workflow filename:** `release.yml`
   - **Environment:** *(leeg laten)*
3. Daarna één keer een `vX.Y.Z`-tag pushen → de workflow publiceert (en maakt) het pakket.

Na deze eenmalige koppeling verloopt elke volgende release volledig automatisch.

## Een nieuwe plugin opzetten met deze methode

Kopieer `.github/workflows/release.yml`, zorg voor een `files`-whitelist in
`package.json` (alleen `dist`, UI-map, `config.schema.json`, docs), en doe de
eenmalige Trusted-Publisher-koppeling hierboven. Verder identiek.
