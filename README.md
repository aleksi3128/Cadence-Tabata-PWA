# Cadence Tabata — PWA

Le site **déjà construit**, prêt à être servi. Ce dépôt ne contient pas de code
source : c'est la sortie de `npm run build:pwa`, publiée depuis le Mac.

Un serveur web statique suffit. Rien à compiler, rien à installer — ni Node, ni
Python, ni dépendances.

```bash
git clone https://github.com/aleksiiiiiii/Cadence-Tabata-PWA.git
cd Cadence-Tabata-PWA && python3 -m http.server 8080   # et voilà
```

---

## Ce que c'est

Un timer Tabata en PWA : séances au temps ou aux répétitions, démonstration
animée de chaque exercice pendant les repos, contrôle Spotify, et des séances
partageables par simple lien.

- **Séances par lien** — une séance entière tient dans une URL
  (`?w=Full+Body~8~60~Pompes:30s:10`). Le format est spécifié dans
  [`llms.txt`](llms.txt), pour que d'autres applications puissent en produire.
- **Bibliothèque de 1324 exercices** — démonstration animée, vignette, et
  instructions pas à pas en français et en anglais.
- **Hors ligne** — après une première visite, le service worker sert
  l'application sans réseau. Les démonstrations se mettent en cache au fur et à
  mesure qu'elles s'affichent.
- **Installable** — sur iOS et Android, depuis le navigateur.

## Contenu

```
index.html          l'application
sw.js               service worker (cache hors ligne)
manifest.json       manifeste PWA
llms.txt            spécification du format de lien, pour les intégrations
js/  css/           code et styles
js/config.js        configuration du build (aucun secret)
icons/              icônes d'installation
sounds/             sons du timer et bips des marqueurs
locales/            traductions FR et EN
exercises/          séances d'exemple
exercise-db/        bibliothèque d'exercices
  catalog.json        1324 entrées — nom, zone, matériel, muscle ciblé
  instructions-*.json instructions pas à pas, FR et EN
  images/             1324 vignettes 180×180
  gifs/              1324 démonstrations animées
manifest.txt        empreinte sha256 de chaque fichier
version.txt         empreinte du build
```

## Servir en production

`install.sh` installe le tout sur un conteneur Debian : nginx, le clone, et une
mise à jour automatique qui suit ce dépôt.

```bash
bash install.sh
```

Il pose ses questions au fur et à mesure. Prévu pour un CT Proxmox derrière un
reverse proxy qui termine le HTTPS.

Pour un autre hébergeur, trois règles suffisent :

| Chemin | En-tête |
|---|---|
| `sw.js` | `Cache-Control: no-cache, no-store, must-revalidate` |
| `index.html`, `.js`, `.css`, `.json` | `Cache-Control: no-cache` |
| `.wav`, `.gif`, `.jpg`, `.png`, … | `Cache-Control: public, max-age=31536000, immutable` |

Et une réécriture de toute navigation vers `/index.html` : un lien de séance
partagé est `index.html` avec une query string, c'est l'application qui lit
l'URL. Servir à la **racine** d'un domaine — `scope` et `start_url` valent `/`.

`sw.js` ne doit jamais être figé dans un cache HTTP : c'est lui qui pilote les
mises à jour de l'application. Un service worker en cache empêche tout
changement d'atteindre les visiteurs déjà venus.

## Mises à jour

Ce dépôt est republié depuis le poste de développement à chaque déploiement.
Un serveur qui le suit n'a qu'à tirer :

```bash
git pull && systemctl reload nginx
```

`version.txt` change à chaque build ; il nomme aussi les caches du service
worker, ce qui purge les anciens chez les visiteurs.

## Licence

Le code est publié sous licence MIT.

Les **médias d'exercices** (`exercise-db/images/` et `exercise-db/gifs/`) sont
**© [Gym visual](https://gymvisual.com/)**. Ils proviennent du jeu de données
[hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset),
qui les redistribue avec la permission écrite de l'ayant droit, à deux
conditions : résolution limitée à **180×180**, et **mention du copyright
conservée**. L'application l'affiche en pied de son sélecteur d'exercices.

Ces médias ne sont pas couverts par la licence MIT ci-dessus et **ne peuvent pas
être réutilisés ailleurs** sans vérifier les
[conditions de Gym visual](https://gymvisual.com/content/3-terms-and-conditions-of-use).

Les *données* d'exercices — noms, zones du corps, matériel, muscles ciblés et
instructions traduites — sont sous licence MIT, séparément des médias.
