# Third-party notices

Files in this package adapted from other projects, and the licences they came under.

## Ruixen UI (MIT)

Adapted from the free registry of Ruixen UI, read on 12 Nov 2026. Each file says at its top which
item it came from and what was changed.

| File | Registry item | Source |
|---|---|---|
| `components/front/navbar.tsx` | navbar-minimal | https://ruixen.com/r/navbar-minimal.json |
| `components/front/hero.tsx` | structured-hero-section | https://ruixen.com/r/structured-hero-section.json |
| `components/front/grouped-faq.tsx` | grouped-faq-section | https://ruixen.com/r/grouped-faq-section.json |
| `components/front/footer.tsx` | footer-pro | https://ruixen.com/r/footer-pro.json |

```
MIT License

Copyright (c) 2025 Ruixen UI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Source Serif 4 (SIL Open Font License 1.1)

`app/fonts/source-serif-4-latin-wght.woff2`: Source Serif 4, latin subset, variable weight, as
published in the `@fontsource-variable/source-serif-4` package 5.2.8 (copied from it, the package
then removed). Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name
"Source". Licence text: `app/fonts/LICENSE-source-serif-4.txt`. Used for the homepage's h1 and h2.

## Packages

Tailwind CSS (MIT), clsx (MIT), tailwind-merge (MIT) and motion (MIT) are dependencies in
`package.json`, under their own licences in `node_modules`.

## NEAR Connect (MIT)

`@hot-labs/near-connect` 0.12.0 (HOT Labs, https://github.com/hot-dao/near-selector), MIT according
to its `package.json` (the package ships no licence file), is a dependency in `package.json`, loaded
by the test bid's "Connect a NEAR wallet". `public/wallets/manifest.json` is a subset of that
repository's `repository/manifest.json` (read 13 Nov 2026): four wallet entries, with the Meteor
and MyNearWallet icons fetched from the URLs the manifest gave and inlined as `data:` URIs, and
MyNearWallet's `features.testnet` set to true. The icons are those wallets' marks, shown only to
name them in the chooser.
