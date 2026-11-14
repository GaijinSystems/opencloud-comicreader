# Comic Reader for OpenCloud: live demo

This branch is the site at <https://comicreader.gaijin.systems>: Comic
Reader, the comic book reader app for OpenCloud Web, running on its own in
the browser on a mock file list, with a few made-up comics. The app itself,
and its documentation, are on the
[main branch](https://github.com/GaijinSystems/opencloud-comicreader).

Everything at the root of this branch is generated. The demo's own source is
in `_demo/`, which the site does not publish (GitHub Pages builds it with
Jekyll, which leaves out names that start with an underscore and copies the
rest as it is):

| Path | What it is |
| --- | --- |
| `_demo/DemoApp.vue`, `main.ts`, `index.html`, `style.css` | The mock file list around the reader. |
| `_demo/web-pkg.ts` | Stand-ins for the four things the reader takes from OpenCloud. The reader's own code is used unchanged. |
| `_demo/vite.demo.config.ts` | Builds the page, the reader and the decoders as a static site. |
| `_demo/comics/` | The demo comics, one per format, and a password-protected one (password `comic`). |
| `_demo/make-comics/` | How the comics are made: pages drawn from shapes in code (no real comic, character or art), rendered in a headless browser, and packed. |
| `_demo/build.sh` | Rebuilds the site from main. |

To rebuild after a change to the reader, with main checked out and this
branch as a worktree inside it:

    git worktree add pages gh-pages
    (cd source/web-app-comic-reader && npm run build:native)
    sh pages/_demo/build.sh

The site contains compiled files (the reader's JavaScript and its
WebAssembly decoders), built from main's source by that script. Their
licences are in `THIRD-PARTY-NOTICES.txt` and `licences/`, which the build
copies in from main.

Free software under the GNU AGPL, version 3 or later, like the app.
