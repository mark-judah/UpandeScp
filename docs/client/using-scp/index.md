---
title: Using SCP
route: scp/using
order: 1
---

# Using Upande SCP

SCP is the scouting and crop-protection app: scouts record what they find in
the field, spray plans are built from it, approved, and sprayed.

This book is for the people doing that daily work.

## Read this first — SCP lives in two places

**Most of your work is not in Desk.**

| Surface | What it is | What lives there |
|---|---|---|
| **The SCP app** at `/scp_app` | A separate application with its own sidebar | Dashboards, scouting map, observations, application plans, approvals, chemical stock — nearly everything you do |
| **Desk** at `/app` | The standard Frappe back office | The reference data behind it all — pests, diseases, chemicals, beds, teams |

A scout doing a day's work barely touches Desk at all.

The five entries at the top of the Desk sidebar — **Dashboards, Scouting Map,
Application Plan, Approvals, Chemical Dashboard** — are not Desk pages. They
are links that take you out of Desk and into the SCP app. Everything below them
in the sidebar is genuine Desk.

If you go looking for a "Scouting Map" page inside Desk, you will not find one.

## The address bar tells you where you are

Inside the SCP app the address looks like this:

```
/scp_app#/rose/scouting-map
          └──┘ └───────────┘
          crop     view
```

**The crop is part of the address.** On an avocado farm the same view is
`#/avocado/scouting-map`; on coffee, `#/coffee/scouting-map`. Switching crop
changes the sidebar, because the three crops do not offer the same things.

## What each crop offers

The app is furthest along for roses. Do not expect an avocado or coffee farm to
have every view described in this book — and note that the three crops are also
scouted on different structures, with different pest and disease lists. Each has
its own chapter.

| | Rose | Avocado | Coffee |
|---|---|---|---|
| **Structure** | greenhouse / bed / zone | block / row / tree | block / row / tree |
| **Pests configured** | 12 | 12 | 16 |
| **Diseases configured** | 6 | 4 | 5 |
| **In use today** | yes | yes | **not yet** |
| Dashboards | yes | yes | yes |
| Trends | yes | yes | — |
| Scouting map | yes | yes | yes |
| Observations | yes | yes | — |
| Heatmaps | yes | as **Jobsheet** | — |
| Traps | yes | yes | — |
| Spraying | yes | — | — |
| Application Plan, Approvals, Postponements, Tank Mixes, Historical | yes | — | — |
| Reports | yes | yes | yes |

## Chapters

1. [Logging in and the two surfaces](01-logging-in-and-the-two-surfaces.md)

**Your crop — read the one that applies to you:**

2. [Scouting roses](02-roses.md)
3. [Scouting avocado](03-avocado.md)
4. [Scouting coffee](04-coffee.md)

**Then the general chapters:**

5. [The Scouting Map](05-the-scouting-map.md)
6. [Recording observations](06-recording-observations.md)
7. [Dashboards and trends](07-dashboards-and-trends.md)
8. [Application Plan — building a spray plan](08-application-plan.md)
9. [Approvals and the spray lifecycle](09-approvals.md)
10. [Chemical Dashboard](10-chemical-dashboard.md)

## What this book does not cover yet

Chemical procurement — allocations, procurement cycles, purchase requirements,
transfer requests and the FRAC/IRAC/GHS compliance reporting — is a second pass.
Those views exist in the app for the roles that use them; they are simply not
documented here yet.
