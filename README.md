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

## Release check

Every site follows its major, so a viewer change reaches every deck on that major at the next Reload. The release check guards that: [`checks/`](./checks) holds a corpus of sample decks, and `checks/run.mjs` serves each deck with the candidate viewer the way SecondStack Sites serves a typed site. It fails when:

- check mode reports an error, or a warning that the deck's `check.json` does not expect, sanitizer removals included;
- a sanitizer payload leaves an execution marker;
- a slide's screenshot, on the stage or in print, light or dark, differs from the same deck rendered by the previous release (the highest `slides-v*` tag at or below the candidate version);
- keyboard navigation, the overview, the presenter window's sync with the audience window, or the PDF page count goes wrong;
- the package changed but `version` did not go up, or `TYPE_VERSION` in `viewer.js` differs from `type.json`.

The check runs on every pull request. To run it locally:

```sh
cd checks
npm ci
npx playwright install chromium
node run.mjs --save          # screenshots in checks/out/shots/, diffs in checks/out/diff/
```

A visual change that is intended within the major (an additive fix, or a security fix to the sanitizer) is accepted per screenshot in `checks/accept.json` under the new version, with a reason. A sanitizer change also updates the expected removals in the affected `check.json`.

To release a new version of Slides:

1. Change the viewer and add a sample deck for any new feature.
2. Bump `version` in `slides/type.json` and `TYPE_VERSION` in `slides/viewer.js`, and update the version in `slides/SKILL.md`.
3. Run the check and open a pull request; its CI runs the check again.
4. Merge into `main`.
5. Tag the merge commit `slides-vX.Y.Z` and push the tag. The tag is the baseline for the next release.

After the tag, delete that version's entries from `checks/accept.json`: they are keyed by the candidate version and never match again. If the tag is forgotten, the next release is compared with the older tag, and the changes accepted for the untagged release come back as failures under a version key that no longer matches; that is the signal to push the missing tag.

## License

The code in this repository is licensed under the [MIT License](./LICENSE). Vendored files inside a package keep their own licenses, listed in the package's `NOTICE.md`: the Slides fonts (SIL OFL 1.1) and DOMPurify (Apache-2.0 or MPL-2.0).
