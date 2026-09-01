---
title: Scouting roses
route: scp/using/scouting-roses
order: 3
---

# Scouting roses

`/scp_app#/rose/…`

Roses are the crop the app was built around, and the only one with the full
feature set. If you are on roses, everything in this book applies to you.

## Where you scout

```
Greenhouse  →  Bed  →  Zone
```

Every rose scouting entry names a **greenhouse** and a **bed**, and almost
always a **zone** — that is the level the map colours. Behind the scenes a
greenhouse is an ERPNext warehouse, which is why chemicals are issued to it and
costs post against it.

## What you can record

**12 pests**

Aphids · Duponchella · FCM · Helicoverpa · Mealybugs · Scale Insects ·
Spidermites · Spodoptera · Thrips · Unidentified Moth · Weevils · Whiteflies

**6 diseases**

Agrobacterium · Bacterial Wilt · Botrytis · Downy Mildew · Powdery Mildew · Rust

Plus weeds, predators, incidents, physiological disorders, traps and crop
modelling — those lists are shared across all crops rather than being
rose-specific.

Each pest and disease carries its own severity thresholds and its own set of
stages for roses. The same pest on another crop can have quite different
thresholds.

## What roses have that the other crops do not

| Section | Views |
|---|---|
| Overview | Dashboards, Trends |
| Scouting | Scouting, **Spraying**, Observations, Heatmaps, Traps |
| Crop Protection | **Application Plan, Chemical Stock, Chemical Loaning, Procurement, Approvals, Postponements, Settings, Historical, Tank Mixes** |
| Reports | Reports |
| Stores *(store keepers only)* | Spray Plan Transfers, Chemical Dashboard, Labels, Chemical Progress |

The whole crop-protection chain — building a spray plan, approving it, issuing
chemicals, mixing, spraying, completing — exists **only for roses**. Chapters
[8](08-application-plan.md), [9](09-approvals.md) and
[10](10-chemical-dashboard.md) are rose chapters in practice.

## In short

Roses are the reference implementation. Everything else in the app is measured
against what roses can do.
