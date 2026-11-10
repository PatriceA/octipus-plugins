# site/src/design

The octipus.cc "ocean" design: tokens (`tokens.css`), the base and layout
styles (`ocean.css`), and the header (`OceanHeader.astro`), navigation
(`OceanNavigation.astro`), footer (`OceanFooter.astro`), atmosphere and page
frame (`OceanLayout.astro`).

**This folder is a stand-in for the shared design source.** The plan
(docs/plans/marketplace.md in PatriceA/octipus, "Decisions: Design") is one
source for octipus.cc and plugins.octipus.cc. The octipus.cc source is not
shared yet, so this is copied from the published site (its HTML and
stylesheet, the `ocean-*` classes and their values) and will be **replaced
when the octipus.cc source is shared**, by importing the shared package or
`design/` folder instead. Until then:

- change the design on octipus.cc first, then copy it here;
- keep the class names (`ocean-header`, `ocean-navigation`, `ocean-footer`, …)
  so the swap is a drop-in;
- the marketplace's own styles live outside this folder (`src/styles/`).

Assets copied from octipus.cc into `site/public/`: `design/ocean/mobile-mark.webp`
(the mark), `icons/mobile-180.png` and `favicon.ico`.
