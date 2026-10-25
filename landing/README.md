# Sahaya — Landing Page

A production-quality marketing landing page for **Sahaya**, a voice-first AI
companion for older adults and their families.

Built with Next.js (App Router), React 19, TypeScript, Tailwind CSS v4,
Framer Motion, and Lucide icons. It is a standalone app, separate from the
Sahaya product demo.

## Run it

```bash
cd landing
npm install
npm run dev     # http://localhost:3001
```

The landing page runs on **port 3001**. Every demo call-to-action
("Experience Sahaya", "Try Live Demo", "Launch the Live Sahaya Demo", etc.)
links to the Sahaya product demo at **http://localhost:3000**, so run the main
app in the repo root (`npm run dev` there) to make those buttons work.

```bash
npm run build   # production build
npm run start   # serve the production build on port 3001
npm run typecheck
```

## Structure

```
src/
  app/
    layout.tsx            fonts, SEO/OpenGraph metadata, skip link
    page.tsx              composes all sections in order
    globals.css           design system (tokens + component classes)
    privacy|terms|contact draft legal/contact pages
  components/
    brand/Logo.tsx        original Sahaya SVG brand mark
    Navbar.tsx            sticky translucent nav + mobile menu
    sections/             Hero, Problem, Solution, Guardian, Care, Wellness,
                          Finance, HowItWorks, FamilyConnection,
                          InteractiveShowcase, TechnologyShowcase, Team,
                          Vision, FinalCTA, Footer
    technology/HoverCloud collision-aware, keyboard-accessible info popover
    ui/                   Reveal, PhoneFrame, ChatPhone, FeatureLayout, etc.
  data/
    technologies.ts       central technology catalog (status: used/planned/dev-tool)
    capabilities.ts       Guardian / Care / Wellness / Finance metadata
public/
  brand/mark.svg          brand mark
  logos/*.svg             technology logos
```

## Accuracy notes

Technology statuses were derived from the actual repository
(`src/integrations/`, `.env.example`, `package.json`):

- **Used in Sahaya**: Cartesia, Convex, Moss, Backboard, Fetch.ai,
  Bitdeer AI, Tiger Data, Snowflake, Elasticsearch, Jira, Claude (Anthropic),
  Auth0, Next.js.
- **Planned integration**: Armadin, Apify, Creao AI.
- **Development tool**: Factory.

All example conversations and visualizations are labeled as illustrative
product scenarios. The copy avoids clinical, security, and financial guarantees
(see Section 25 of the build brief).
</content>
