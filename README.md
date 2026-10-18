# SecondStack site types

Site types for SecondStack Sites. A site type is a viewer that many sites share: the site holds only its data files, and the type supplies `index.html` and the viewer files. Agents then write small, structured data instead of a whole web page, and a fix to the viewer reaches every site that uses the type.

| Folder | Type |
|---|---|
| [`slides/`](./slides) | Slides: a presentation deck, one HTML section per slide, in a 16:9 viewer with overview, presenter view, fullscreen and print to PDF. |

## Layout

Each folder at the root holds one type at its current version. The version is the `version` field of the folder's `type.json`. Earlier versions are in the Git history, and each release has a tag named `<type>-v<version>`, for example `slides-v1.0.0`.

A package is:

- `type.json`: `format`, `name`, `version` (SemVer), `title`, `description` and `data`, the data paths a site of this type may write;
- `index.html`: the viewer entry;
- `SKILL.md`: optional instructions that agents read before they write a site of this type;
- the other viewer files (scripts, styles, fonts).

Links, dot files and `node_modules` are not allowed in a package. A package has at most 2,000 files and 90 MiB.

## Install a type in SecondStack

A platform admin installs types in ControlTower, on the Sites page, in the Site types card.

- **From GitHub:** paste the folder URL with an explicit ref, for example `https://github.com/SecondStack-AI/site-types/tree/main/slides` or `https://github.com/SecondStack-AI/site-types/tree/slides-v1.0.0/slides`. ControlTower keeps the URL as a source. **Reload sources** fetches every source again and installs a new version when the folder has one.
- **From a zip:** upload a zip that holds the package folder. Use this for a private fork, or when ControlTower cannot reach GitHub.

A source at `main` follows the releases of this repository: after a Reload, every site that uses the type moves to the newest version of its major. A source at a release tag stays on that release until you add a source with a newer tag. Choose a tag when you want to decide when sites move.

Only public repositories are supported, and the ref must be one path segment: a branch, a tag or a full commit SHA. A branch name that contains `/` is not supported.

## Trust

Installing a type means trusting it. Its viewer runs with the visitor's authority on every site that uses it, and its `SKILL.md` steers the agents that write those sites. Read a type before you install it, and install a fork only from a repository you control.

## Fork and change a type

1. Fork this repository, or copy one type folder into your own repository.
2. Change the viewer, and bump `version` in `type.json`. An installed version can never change: an upload with different bytes under an installed version is refused. Develop under a prerelease version, for example `1.1.0-dev.1`.
3. To run your fork beside the original, rename the type: change `name` in `type.json`.
4. Install your folder URL in ControlTower, and press **Reload sources** after each release.

## Compatibility rule

Every SecondStack site follows the newest version of its type's major. So a minor or patch release must keep the data contract and keep existing sites working: the data paths, the data format and every building block that `SKILL.md` documents change only additively. A change that breaks this is a new major version.

For Slides this means: within a major, the 1920×1080 frame, the default palette and fonts, the layouts and every building block `SKILL.md` documents change only additively. Sanitizer changes are the exception and are allowed for security. Anything else is a new major, which also bumps `deck.json` `v`.

## License

The code in this repository is licensed under the [MIT License](./LICENSE). Vendored files inside a package keep their own licenses, listed in the package's `NOTICE.md`: the Slides fonts (SIL OFL 1.1) and DOMPurify (Apache-2.0 or MPL-2.0).
