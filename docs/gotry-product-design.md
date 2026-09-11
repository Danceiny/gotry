[English](gotry-product-design.md) | [简体中文](gotry-product-design.zh-CN.md)

# GoTry Product Design: From Departure to the Next Departure

> Single current version (history in git log; no file-level version numbers)
> **Date**: 2026-08-22
> **Audience**: GoTry's future product and engineering team; and anyone who wants to understand why this product exists
> **Status**: Draft. The launch market is not locked; market-sensitive items in the text are marked with "📍" and summarized in Chapter 12; content marked "to be confirmed" will be completed after market lock or team formation. **This document does not replace any formal legal/financial/compliance documents.**

---

## 0. Reading Notes

- The document's main thread in one sentence: **GoTry is not yet another itinerary generator, but a full-cycle AI travel companion "from departure to the next departure"**—it starts serving the user at "why depart" and completes one service cycle only at the user's "next departure".
- The two values are not slogans but product mechanisms: human care lands in the "motivation-first" product main loop (Chapter 5); transparency lands in the first-class features of "recommendation cards + commission disclosure" (Chapter 6). Every value points to a concrete mechanism (Section 2.3 gives the mapping table).
- Market not locked: designed as a market-agnostic product; Chapter 3 compares three candidate markets (China outbound / domestic in-depth travel / global English); market-sensitive items are marked in place throughout.
- Technical foundation stance: backend atomic capabilities (city search, hotel search/static data, geo-mapping, etc.) **reuse hotel-be's existing capabilities as much as possible, avoiding the maintenance of two stacks**; HotelByte is only one of GoTry's hotel supply chains, not a product prerequisite (Section 7.8, Appendix B).
- Key claims carry research citations; sources are collected in Appendix A.

---

## 1. Executive Summary

**GoTry is an AI-native travel Agent product: starting from "why depart", it accompanies the user through inspiration, choice, planning, booking, on-the-road, and memories, until the "next departure".**

It differs fundamentally from existing travel products in three ways:

1. **Start from motivation, not from destination.** The first question every travel product today (OTA, itinerary generator, general AI assistant) asks the user is "where, when, how many people". GoTry's first question is "why do you want to depart". This is the productization of the mission "body and soul, more travel, less tourism": tourism is "having been there"; travel is "having experienced it". "Why depart" is also the reuse seam for B2B—the B2B customer's "why" is wrapped ("my customers depart because of xxx"); once the motivation layer is built as a wrappable plugin, B2B directly reuses 99% of the capability (see 2.2 and Master Outline 3.7).
2. **Transparency is a mechanism, not a slogan.** Every recommendation carries a why (why it is recommended to you, what the evidence sources are) and a cost (a complete price breakdown, including how much GoTry itself earns from it). Product red lines: no paid ranking, no hidden costs. Where the industry makes money from information asymmetry, GoTry makes money by laying it all out. And **cost is not just money**: door-to-door time, energy, and circadian rhythm are priced as well (6.5 full-cost model).
3. **Deterministic guarantee.** Itinerary feasibility (time, geography, budget, physical stamina) is verified by a deterministic solving engine; the LLM is only responsible for understanding the user and explaining results—pure LLM-generated itineraries achieve only 4.4% feasibility on the TravelPlanner benchmark, while a hybrid LLM + constraint-solving architecture reaches 93%+ (Appendix A-6).

**North Star metric: next-departure rate**—the share of users who complete a second trip within 12 months. It measures product value (the user actually departed), human care (service continued to the next trip), and the business model (the repurchase basis for subscriptions and commissions) at the same time.

**Three-layer business model**: free planning and companionship (the entry point of trust) / GoTry Plus subscription (anchored against Layla at $49/year) / booking commissions (transaction share under full disclosure; users can always choose a cheaper non-GoTry channel).

**Three-step roadmap**: M1 gets planning right (no booking) → M2 remembers you + on-the-road → M3 booking loop + next departure + subscription. Each step is an independently verifiable minimal closed loop, evaluation first.

> This chapter answers "what to build, how, and how it differs". For why build it, see Chapter 2.

---

## 2. Mission, Vision, and Values

> This chapter answers "why build it". The remaining chapters of the product design answer "what to build and how".

### 2.1 Mission

**Body and soul, more travel, less tourism.**

"Travel" (旅行) and "tourism" (旅游) are not a rhetorical difference here, but two kinds of products:

| | Tourism | Travel |
|---|---|---|
| Goal | Having been there, checking in, stamp collecting | Experiencing, feeling, changing |
| Metric | Number of attractions | Experience density and slack |
| Decision mode | Copying guides | Composition around personal motivation |
| End marker | Getting home | Bringing something home (repaired relationships, restored energy, answers found) |

Nearly all travel products on the market today optimize for "tourism": more attractions, fuller itineraries, lower prices. "More travel, less tourism" means GoTry optimizes a different objective function—not getting users to "visit more places", but getting users to "have more real travel": motivations understood, itineraries with slack, experiences with depth, and something settled after the trip ends.

"Body and soul" comes from the saying "either the body or the soul is always on the road": **the body on the road (traveling) and the soul on the road (yearning, remembering, the germ of the next trip) are both service moments of the product**. This directly determines that GoTry's service boundary is not "order completed" but the full cycle of yearning → traveling → remembering → yearning again (Chapter 5).

### 2.2 Vision

**Let everyone who holds a beautiful aspiration for travel use "GoTry".**

"Aspiration" is the key word. Users can enter the product with nothing decided yet—no destination, no dates, only a mood or a thought. Today's travel products cannot serve the "aspiration-only" state (the search box demands you enter a destination first); general AI assistants can chat but cannot accompany to the end (no trip state, no real-time data, no transaction loop). **Aspiration itself is demand; GoTry starts serving from here.**

**B2B is an amplifier of this vision, not another product.** Travel agencies, hotels, airlines, and destination tourism operators face the same question—"why does the customer depart"—and in wrapped form: "I want to use GoTry because my customers depart to 'escape for a weekend'". GoTry's motivation layer is designed to be wrappable (principal = the traveler, sponsor = the operator): the B2B version swaps the entry point and inventory pool and wraps sponsor configuration, while keeping the full kernel—motivation interview, feasibility engine, transparent cards, itinerary planner, memory, async planning—**99% of the capability is directly reused**, and the red lines (transparency, commission disclosure) apply to B2B end travelers as well.

### 2.3 Values → Product Mechanism Mapping

Every value must point to a concrete mechanism; otherwise it is a slogan.

**Human care: pay attention to why the user "departs", help the user solve problems, until the "next departure".**

| Value statement | Landing mechanism | Section |
|---|---|---|
| Pay attention to why the user departs | The motivation interview is the product's first interface, ahead of all search and recommendation; it produces a motivation profile and drives planning | 5.1, 4.2 |
| Help the user solve problems | Failure attribution of the feasibility engine: never says "cannot plan", but "budget short by ¥300 / time short by half a day; any one of these three fixes solves it" | 7.5 |
| Help the user solve problems | On-the-road companionship: real-time rescheduling for delays, closures, and sudden weather changes, instead of a dismissive "please contact the provider" | 5.5 |
| Until the next departure | The end of the product main loop is not order completion but the next departure; the North Star metric is defined accordingly | 5.7, Chapter 9 |

**Transparency: itinerary planning and third-party recommendations never hide the why and the cost.**

| Value statement | Landing mechanism | Section |
|---|---|---|
| Never hide the why | Every recommendation carries motivation-match rationale + evidence source + data freshness | 6.1, 6.3 |
| Never hide the why | Ranking factors and weights are public; no paid factors | 6.4 |
| Never hide the cost | Every recommendation carries a complete price breakdown | 6.1 |
| Never hide the cost | Every transaction involving GoTry earnings discloses the amount; zero-earnings transactions are labeled "¥0" | 6.2 |
| Never hide the cost | Users can always choose a cheaper non-GoTry channel, and GoTry recommends it all the same | 5.4 |

### 2.4 Product Red Lines (Hard Boundaries)

Red lines are non-negotiable constraints; they hold in every version and under any commercial pressure:

1. **Never push sales to users who have not asked.** Proactive outreach has exactly one legitimate form: the "next departure" suggestion (and it can be turned off, 5.7).
2. **The recommendation feed never sells ranking.** Bidding does not affect ordering. If ad slots ever exist in the future, they must be explicitly labeled and never mixed into the recommendation feed.
3. **Every sum of money is explainable.** Before any transaction, the user sees the complete price breakdown and GoTry's own earnings.
4. **No fabrication.** Any POI/price/schedule entering an itinerary must have a data source and a verification record (6.3); model knowledge must not enter an itinerary without verification.
5. **Writes always require explicit user confirmation** (7.4 WriteGate): booking, payment, changes/refunds, sending messages to third parties.
6. **User memory belongs to the user.** Visible, editable, deletable, exportable (7.6).

---

## 3. Problem and Market

### 3.1 How Users Travel Today (Problem Definition)

The current state of a single trip decision (research summary; sources in Appendix A):

- **Extremely high planning cost**: users spend fragmented time ranging from hours to months on one trip, bouncing back and forth among OTAs, airlines, maps, review sites, and social media.
- **Fragmented and asymmetric information**: prices, inventory, and secondary spending (in-park extra fees, hotel deposits, tips) are extremely unfriendly to new users.
- **AI tools are untrustworthy**: fabricating nonexistent attractions and quoting outdated prices are frequently observed problems in testing; most solutions stop at city granularity, while users need POI and route granularity.
- **Missing real-time data**: flight/hotel prices and inventory change in an instant; general-purpose LLMs cannot reach OTA real-time inventory, so a plan one step slower is already invalid.
- **Trust deficit**: hidden commissions, big-data price discrimination against loyal users, bid-based ranking—users default to assuming "recommendation = whoever paid".

In one sentence: **users want "reliable + worry-free"; the industry offers "more choices + more traps".**

### 3.2 Competitive Landscape

| Category | Representatives | Strengths | Weaknesses (structural) |
|---|---|---|---|
| OTA + AI | Ctrip/Trip.com (携程/Trip.com), Booking | Transaction loop, supply chain, installed user base | Ad and commission model **structurally opaque**; AI is a traffic funnel, not a companion |
| AI itinerary generators | Layla (acquired by Expedia in 2026-07), Mindtrip | Conversational experience, inspiration, AI+human hybrid | **chat-only**: user tests criticize the lack of maps, itinerary overview, and guided flow; feasibility unverified |
| Tool-type planners | TREK (open-source self-hosted), Wanderlog | Maps, collaboration, structured itineraries | No Agent, no motivation understanding; a "better spreadsheet", not a companion |
| General AI assistants | ChatGPT etc. | Comprehension, free-form dialogue | No real-time data, no trip state, no loop closure, unverified hallucinations |
| Content/experience communities | Xiaohongshu (小红书), Mafengwo (马蜂窝), Yuanzhou Guiji (圆周轨迹) | **Density of real folk wisdom** (ride-hailing availability, tourist rip-offs, differences in local management quality) | Unstructured, must be read by people themselves, truth and timeliness hard to judge, cannot enter the planning flow |

**GoTry's position: an Agent's understanding and companionship × a planner's structure and maps × anti-OTA transparency.** No product today combines all three—Layla validated the value of the category (acquired by Expedia) and also exposed the chat-only product flaws; that is exactly GoTry's entry point.

### 3.3 Candidate Markets (Not Locked 📍)

| | China outbound travel | Domestic in-depth travel | Global English market |
|---|---|---|---|
| Market size | Large | Medium | Large |
| Pain-point density | Highest (visas, multi-leg itineraries, fragmented information, language) | Medium | High (hidden fees, fragmented information) |
| Supply-chain barrier | High (overseas flights/hotels/activities) | Low | High |
| Competitive intensity | OTAs strong but slow to AI-ify | High (squeezed by content platforms + OTAs) | High (Layla/Mindtrip head-on, with Expedia backing) |
| Transparency-value resonance | Strong (price-discrimination-against-loyal-users context) | Medium | Strong (hidden fees context) |
| Synergy with hotel-be | Medium | High | Medium (HotelByte covers the Middle East/China) |

**Recommendation**: M1 runs seed validation with "Chinese-speaking users + outbound or domestic in-depth scenarios" (the best team-language and supply-chain synergy); the formal lock is decided before M1 launch (Chapter 12). The rest of this document follows a market-agnostic product design, with sensitive items marked in place.

### 3.4 Why Now

1. **The hybrid architecture's feasibility is proven**: itinerary-planning feasibility of LLM-translated constraints + deterministic solving reaches 93%+ vs 4.4% for pure LLM (Appendix A-6); "hallucination-free itineraries" move from research into engineerability.
2. **The category is validated**: Expedia acquired Layla (2026-07); the giants are paying for AI itinerary planning and booking capability.
3. **Cost is feasible**: the levers of model tier routing, context compression, caching, and batch processing stack to cut 84-91% (Appendix A-7); the economics of long consumer-facing sessions hold for the first time.
4. **Low supply-chain cold-start cost**: hotel-be already offers reusable hotel/city atomic capabilities and a ready hotel supply chain (HotelByte), saving a large chunk versus starting from zero (Section 7.8).

---

## 4. Users and Scenarios

### 4.1 Three Core Personas

| Persona | Entry state | Typical quote | Core need |
|---|---|---|---|
| **Inspiration-driven** | Nothing decided, has a mood | "I'm so tired lately, I want to get out for a while" | Someone turns my mood into a worthwhile trip |
| **Plan-driven** | Has a destination, fears traps | "Taking my parents to Xi'an for the October holiday, 5 days, not too tiring" | A reliable, adjustable, reasonable itinerary |
| **Spontaneous** | Decides on the go | "I'll see when I get there tomorrow" | Someone who can catch me on the road anytime |

The three personas share one thing: all want "travel" rather than "tourism"—averse or indifferent to check-in lists, caring about experience quality and slack. They differ only in the stage where they enter the loop (inspiration-driven enters at 5.1, plan-driven at 5.3, spontaneous at 5.5); **the loop itself is the same**.

### 4.2 Motivation Taxonomy: The First Six Classes of "Why Depart"

What the motivation interview (5.1) produces is not labels but **constraints** entering planning and solving:

| Motivation | Typical expression | Planning implication (into the feasibility engine) |
|---|---|---|
| Escape and recovery | "I want to empty my mind", "I need a breather" | Low density; fewer hotel changes; filter out queue-type attractions; tighten the daily movement cap |
| Relationship and companionship | "Taking my parents", "with the kids", "anniversary" | Adjust pace to companions' physical tier; avoid high-risk activities; reserve slots for shared experiences |
| Challenge and achievement | "I want to trek Gongga", "get a diving certificate" | Training/equipment prerequisites; explicit modeling of physical constraints; window (weather/monsoon) checks |
| Curiosity and understanding | "I want to eat my way into understanding Chaozhou cuisine", "understand Jinci Temple" | Depth over breadth; reservation/closing-day checks; docent-resource matching |
| Healing and farewell | "Between jobs", "a journey to see myself off" | Privacy; fault-tolerance slack; avoid crowd peaks |
| Inspiration and creation | "Looking for shooting material", "want to write something" | Access light/season/photo-spot data; leave blank time blocks |

Motivations can be compound (parents + escape), expressed as a weighted spectrum. **Motivation is the longest-lived layer in GoTry's memory system** (7.6): destinations change, motivations stay stable across years—this is the anchor for personalizing the "next departure". Motivation also determines the **money-time-energy exchange rate** (6.5): saving the same ¥400 may be a good deal for the challenge-and-achievement type but self-destruction for the escape-and-recovery type—the engine prices by motivation, not by a uniform standard.

### 4.3 Scenario Stories

**Story 1 (inspiration-driven, full loop)**: An engineer who has worked overtime for three straight months opens GoTry late at night: "I want to disappear for a few days." Three rounds of motivation interview identify "escape and recovery (0.7) + curiosity and understanding (0.3)", low physical tier, budget ¥5k. GoTry offers three candidates: slow cycling and lakeside stays at Qiandao Lake, wandering the old town of Quanzhou, circling the lake in Dali. Each candidate is a transparent card: why it matches the motivation, budget range, time cost, seasonal risks. He picks Quanzhou and gets a three-day-two-night itinerary with only one main line per day plus abundant slack—not 40 check-in points. After returning, GoTry automatically settles trip memories and expense reconciliation; three months later, a dismissible "next departure" suggestion arrives: "Your escape index is high again. Quanzhou during the October holiday, avoiding the crowds—or try somewhere new: Chaozhou. You know the reason: the food."

**Story 2 (plan-driven, feasibility engine)**: A user takes parents (70+/68+) to Xi'an for 5 days. Engine modeling: both seniors' effective daily sightseeing time ≤5h, avoid elevator-less lodging, midday-rest blocks, heritage-site attractions ≤1 per day. The original Day 3 plan (Terracotta Army + Huaqing Pool + The Song of Everlasting Sorrow) solves to infeasible (round-trip transport 3.5h exceeds the limit). The engine outputs minimal-change suggestions, pick one of three: "drop The Song of Everlasting Sorrow and switch to next day's midday session" / "change the Terracotta Army to a half-day guided tour" / "swap Day 3 and Day 4 to avoid Monday closures". The user picks the third. On the day of the trip a high-temperature orange alert is issued, and the on-the-road agent proactively swaps the outdoor and indoor segments.

**Story 3 (spontaneous, on the road)**: In Chiang Mai, the user decides during the day to go to Pai tomorrow. "The bus departing at 7:00 tomorrow still has 4 seats (Aya, ¥45, 3.5h with many curves—you mentioned motion sickness last time, so pack motion-sickness pills; alternatively a private car at ¥900 can stop at three scenic viewpoints along the way)." One message completes the query, historical-memory recall, risk warning, and two transparent options at once.

**Story 4 (aspiration-material type, the opposite of "tone-deaf")**: A Shanghai user sends a photo of Dali's Erhai Lake late at night: "I want to go here." GoTry does not start recommending Erhai—it first sees the constraints: a 2-day weekend, departing from Shanghai, and what it computes is the **door-to-door true cost** (6.5): you don't choose the schedule, arrive at the airport two hours early, home-to-hub is another leg, and after landing comes an unfamiliar transfer—for an ordinary person, one way is a full day. Its reply: "What moves you in this photo is more like the feeling of 'doing nothing at all by the lake'. A weekend from Shanghai to Erhai means getting up before dawn to catch a flight, arriving at the lodging in the afternoon, half exhausted—for a weekend of 'wanting to unwind', the journey itself ruins the purpose. This feeling exists on a weekend too: Qiandao Lake (about 4h door-to-door), Taihu Lake... I've also put Erhai on your 'next departure' list: it deserves 5+ days, best in spring or autumn. Want to see the Qiandao Lake plan?"

The material is respected, the aspiration is caught, and the full cost is honestly executed. Every AI product today fails this question: they only recommend the most relevant part (faithfully recommending Erhai), caring nothing about the user having only one weekend and being in Shanghai. **Without solving "why depart", AI cannot even price the cost—it does not know whether to count this departure in money, time, or energy.**

---

## 5. Product Design: Departure to Next Departure (Core Chapter)

The product main loop (departure-to-departure loop):

```
(1)为什么出发 → (2)去哪里 → (3)规划 → (4)预订 → (5)在路上 → (6)回来之后
      ↑                                                                    ↓
      └──────────────────── (7)下一次出发 ←────────────────────────────────┘
```

One TripState (long-horizon state, 7.6) runs through the seven stages: motivation profile, constraints, itinerary, evidence, and spending records all evolve in the same object. Users can enter at any stage (plan-driven users go straight to (3), spontaneous users straight to (5)); the loop closes for everyone.

### 5.1 Why Depart (Why)

**The motivation interview is the product's first interface.**

- Form: 3-6 rounds of natural-language dialogue, producing a MotivationProfile (motivation spectrum + weights, pace preference, budget tier, physical tier, companions, dietary/cultural taboos). Not a form—the agent asks, the user answers naturally, and the agent extracts structure from the answers (borrowing the T system's tool-owned parameter-extraction practice, 7.3; the T system = an enterprise-grade business-travel Agent production system, source anonymized).
- Where human care lands: **listen first, recommend later**. There are no recommendations and no search box at this stage.
- Exit condition: the user says "I just want to go to X"—jump straight to (3); the motivation is still recorded ("known destination" does not equal "known motivation").
- Respect boundaries: the user can decline to answer any question; the profile is always editable (red line 6).
- **Material is an expression of aspiration, not a destination command (product iron rule)**. A user sends a photo of Dali's Erhai Lake saying "I want to go here"—the photo is an expression of aspiration, not a destination command; relevance is not intent. The parsing order for any material (photo/place name/link/guide):
  1. **Material → aspiration**: extract the imagery and the emotion ("doing nothing at all by the lake"), rather than locking onto the place name;
  2. **Constraints before material**: origin, time budget, budget tier, and physical tier are hard constraints; the destination in the material is only a soft preference;
  3. **Retrieve candidates by imagery**: within the hard constraints, retrieve destinations of the same imagery (weekend + Shanghai + idling by a lake → Qiandao Lake/Taihu Lake/Dianshan Lake...); the candidate set may completely exclude the place name in the material;
  4. **Aspiration is never rejected**: if the material's destination is infeasible, it enters the "next departure" list together with its feasibility conditions (Erhai: 5+ days, spring/autumn, about 3.5h direct flight)—never say "no"; say "not now, and here is when it is worth it".

### 5.2 Where to Go (Where)

3-5 destination candidates, **each candidate a transparent card** (the destination version of 6.1):

- why: why it matches your motivation (quoting your interview words), and the destination distribution of users with motivations similar to yours (anonymous, aggregated)
- cost: budget range (full-price basis, including main transport), time cost (including visa and flight 📍), seasonal risks (typhoon/peak season/closure season)
- trade-off: each candidate explicitly states "what you give up by choosing it"

- **Candidate generation order: constraints before material** (the execution side of the 5.1 iron rule): fix origin/time budget/budget tier/physical tier first, then retrieve candidates by **imagery** (not place names); the destination in the material is only one candidate and must pass the same transparent card's why/cost scrutiny as all other candidates.
- **Never give a single "best destination" answer**—the choice and the reasons for the choice stay in the user's hands. This is a deliberately opposed product form to the OTA's "guess where you'll go" feed.

### 5.3 Planning (Plan)

What planning produces is a **structured itinerary, not a passage of chat text** (fixing the biggest flaw of chat-only competitors, 3.2):

- **Day planner**: drag-and-drop schedule; moving items across days automatically re-verifies feasibility
- **Map view**: all points, routes, and durations visualized
- **Budget view**: itemized budget vs estimated spending
- **Real-time feasibility verification**: opening hours, transit durations, daylight windows, budget, stamina—the engine solves continuously while editing (7.5); conflicts are flagged red immediately with minimal-change suggestions
- **Every arrangement expands to why + cost** (6.1)
- **Versioning**: plan A/B coexist, comparable, rollback-able—"comparison" is itself transparency

### 5.4 Booking (Book) 📍 (Compliance Scope Follows Market Lock)

Ships in M3. Three hard rules:

1. **WriteGate three-step confirmation** (7.4): details → total price (including GoTry earnings disclosure) → explicit confirmation. Idempotency keys prevent duplicate submission.
2. **Price-comparison transparency**: prices for the same inventory from multiple channels are listed side by side; **if a non-GoTry channel is cheaper, recommend it all the same and support jumping over**. Losing commission in the short term, winning "recommendations you can trust" in the long term—this is the most expensive and most worthwhile bet of the transparency value.
3. **Commission disclosure** (6.2): every transaction shows GoTry's earnings amount or ratio.

### 5.5 On the Road (Go)

Companionship during the trip—**a continuation of the same TripState, not a cold-started customer service**:

- Live conditions: weather alerts, crowd forecasts, sudden business-status changes
- Incident response: flight delays / attraction closures / temporary controls → real-time rescheduling (the engine re-solves under the existing constraints, with reasons given for changes)
- Same-day tuning: "I'm too tired today" → the engine shrinks the day's arrangements per the physical tier
- Local inquiries: transport, local customs, emergencies (nearest hospital/embassy 📍)

The on-the-road agent knows the user's motivation, physical tier, the road already traveled, and what remains unvisited—this is the dividing line between a "companion" and "customer service".

### 5.6 After Returning (Return)

- **Automatic settling of trip memories**: route map, timeline, photo slots (voluntarily uploaded by the user), expense reconciliation
- **Transparent expense reconciliation**: budget vs actual; every line opens to show the original estimate and its rationale—the transparency loop closed: promises made before departure are honored after return
- **Lightweight retrospective**: what was worth revisiting, what was not, correction suggestions for similar motivations next time (into memory)
- **Experience reflux**: experiences from the retrospective that are "worth telling the next person" are extracted into structured entries and, after user confirmation, enter the shared experience pool (6.6)—"you were helped by the last traveler; you help the next one"

Where human care lands: **returning is not the end**. This is a segment the industry broadly misses—service terminates when the transaction completes.

### 5.7 Next Departure (Next)

- **Proactive follow-up**: "next departure" suggestions based on motivation evolution + seasonal windows + price windows. Dismissible, frequency-adjustable; this is the only legitimate proactive outreach form under red line 1.
- **Motivation profile update**: each trip's retrospective feeds back into the profile—"an escape-type user beginning to show curiosity motivation" is itself the basis for the next recommendation.
- The North Star is defined and measured here: **next-departure rate** (Chapter 9).

---

## 6. Transparency Mechanism Design

> Transparency is not a promise on an "About Us" page; it is the data structure of every atomic unit (recommendation) in the product.

### 6.1 Recommendation Cards (The Product's Atomic Unit)

Every recommendation (destination, hotel, route, restaurant, activity) unifies into a four-part structure:

```
┌─────────────────────────────────────────────────────┐
│ What  千岛湖·湖畔骑行 + 环湖慢住两晚                     │
│ Why   · 匹配动机:你说想「不带脑子地放空」(逃离与休整 0.7) │
│       · 骑行强度低,符合你的体力档(用户记忆,2026-06 访谈)│
│       · 10 月千岛湖均温 22°C,适骑(Open-Meteo 历史数据) │
│       · 距住处 4.2km,在 Day2 路线上(地图 API,实时)     │
│ Cost  门票 ¥65 + 租车 ¥40/2h + 住宿 ¥480/晚 ×2          │
│       本项合计约 ¥1,065(占预算 21%)                     │
│       GoTry 收益:¥0(无合作分成)                        │
│ 备选  环湖东线更安静但餐饮少 ¥60;若在意,选西线            │
└─────────────────────────────────────────────────────┘
```

- **Every line of the why carries an evidence source and data freshness** (6.3).
- **The cost is full-price basis**: it explicitly lists easily hidden secondary spending (deposits, tips, equipment rental 📍per market convention), plus door-to-door time and arrival state (see 6.5).
- **The alternatives section discloses runner-ups and the reasons they were dropped**—transparency is not only about what is recommended, but also about what is not.

### 6.2 Commission Disclosure

- Every transaction involving GoTry earnings shows the earnings amount or ratio before confirmation.
- Zero-earnings transactions are labeled "¥0 (no partnership share)"—**zero commission must also be stated**; otherwise users cannot distinguish a "real recommendation" from "shilling".
- Benchmark: the industry hides commissions and bid-based ranking by default; GoTry does the reverse, making the entire recommendation feed auditable.
- Compliance scope (disclosure format, tax rules) is confirmed after market lock (Chapter 12) 📍.

### 6.3 Evidence Chain and Data Freshness

All data entering recommendations and itineraries has sources in three categories, explicitly labeled on the card:

| Label | Meaning | Bar for entering an itinerary |
|---|---|---|
| [Real-time API] | Supplier/map/weather interfaces, with fetch time | If not refreshed within the timeout, label "price may have changed" and block from entering booking confirmation |
| [User memory] | Facts the user has told us (preferences, taboos, stamina) | References must be traceable to the original conversation/edit record |
| [Shared experience] | Folk wisdom flowed back by travelers (e.g., "ride-hailing in Lijiang is harder to get than in Dali; only a several-fold markup gets a driver to accept") | Carries corroboration counts and time-window decay; a single uncorroborated entry serves only as a hint, never as a basis (6.6) |
| [Model knowledge] | LLM parametric knowledge | **Must pass existence verification (data-source cross-check) before entering an itinerary**—the hard anti-hallucination gate |

No POI (name, location, business status) may enter an itinerary without verification (red line 4).

### 6.4 Explainable Ranking

The factors and weights of recommendation ranking are public (documented); no paid factors (red line 2). Users can ask "why is A ranked ahead of B" and get a factor-by-factor answer.

### 6.5 Full Cost: The Exchange Rate of Money, Time, and Energy

**The true unit of cost is not money but lived experience.** The rich travel comfortably because they can buy time and convenience with money; budget travel is **trading time (and energy) for money**—both choices are legitimate, but today's travel products only display money, and AI does not even compute the rest. That is exactly why the "Shanghai-Dali 3.5h flight" in Story 4 (4.3) amounts to a full day for an ordinary person.

**Door-to-door true cost**, computed for every intercity leg:

| Component | Content |
|---|---|
| Schedule constraint | You don't choose the schedule (early/red-eye); a "3.5h flight" is actually "only the 7:50 flight exists" |
| Upfront buffer | Time to arrive at the hub early + home-to-hub time → determines wake-up time |
| Circadian cost | The damage of pre-dawn wake-ups / late-night arrivals to one's routine (fatal for recovery-type motivations) |
| Transfer and navigation | Hub→lodging transfers; the cognitive load of finding the way on a phone in an unfamiliar place |
| Arrival state | Arrival time + remaining energy → determines the day's remaining effective hours |
| Money | Ticket + transfers + hidden fees (the only item displayed today) |

**Arrival-state model**: the feasibility engine (7.5) computes "arrival time + remaining energy" for every intercity leg. Under a recovery-type motivation, arriving after a pre-dawn wake-up plus two transfer legs means the day's effective time approaches zero, and the engine directly flags **"this arrangement conflicts with your departure motivation"**—the tool must not destroy the purpose.

**Transparent exchange, no judgment of choices**: GoTry does not treat budget travel as a second-class option (trading time for money is a legitimate strategy); it lays the exchange out in the open: "The price of saving ¥400: wake at 5:30, 2 transfers, expected arrival at lodging 14:00, about 30% energy left for the day". The Cost section of the transparent card (6.1) is thus upgraded from a "price breakdown" to **full cost**: money + door-to-door duration + wake-up time + arrival-state estimate + exchange comparison with alternatives. This is the complete form of the transparency value in the cost dimension: **never hide the cost—and cost is not just money.**

### 6.6 Shared Experience: Data No Official Channel Has

There is a class of information that determines the real experience and **no official channel can possibly provide**: ride-hailing cars in Lijiang are far scarcer than in Dali—in Dali a small markup gets you a car, in Lijiang it takes several times more; the two cities' tourism administrations are worlds apart in competence. Today this kind of experience lives in Xiaohongshu notes (useful, but people must read them themselves and judge truth and timeliness) and in communities like Yuanzhou Guiji (some like it, some don't), but **it exists in no structured data source**—officials won't say it, and no API has it.

**The new form in the AI era: shared experience that exists as structured, confidence-scored, agent-directly-consumable data.**

- **The Experience Entry is the minimal unit**: an assertion ("at peak hours in Lijiang you must add a 2-3x markup before anyone accepts the ride") + place and time window + proposer + **corroboration** (confirmations/rebuttals/updates from other travelers, with timestamps) + freshness decay. Experience is alive: management changes, and expired entries lose weight.
- **The reflux mechanism closes the loop with 5.6**: when memories settle, experiences "worth telling the next person" are extracted into entries and shared after user confirmation—"this time in Lijiang you had to add a 2x markup to get a car; want to tell the next person going to Lijiang?" This is the reciprocal form of human care: **I was helped by the last traveler; I help the next one**.
- **Three consumption surfaces**: ① the transparent card's why gains a new evidence type [Shared experience](past 90 days, corroborated by 11 people); ② the feasibility engine uses shared experience to calibrate door-to-door true cost (6.5)—Lijiang's ride-hailing difficulty directly affects estimates of transfer time and energy deduction; ③ motivation matching—"chaotic management, easy to get ripped off" is a strong negative signal for escape-and-recovery types, not necessarily for challenge-and-achievement types.
- **Confidence and anti-abuse**: corroboration counts + time decay; a single uncorroborated entry serves only as a hint, never as a basis; merchant self-promotion and astroturfing are the adversarial surface (an offense-defense game sharing its root with the "never sell ranking" red line).
- **Cold start**: seed users' destinations are covered deeply and in a concentrated way; the founding team's own experience is the first batch of entries; public content (Xiaohongshu/guides) only undergoes **manual distillation of factual assertions**, never content copying (copyright and platform-rule red lines).
- **This is the moat**: OTAs won't do it (transaction-oriented), officials can't (conflict of interest), general AI can't (no reflux loop). Shared experience compounds with user volume and simultaneously strengthens transparency (truer evidence) and feasibility (more realistic parameters).

---

## 7. Agent Architecture

> This chapter states engineering design positions, not implementation details. Core principle: **the LLM handles understanding and explanation; deterministic systems handle state and solving; writes are always gated.**

### 7.1 Layered Overview

```
入口层    App / Web /（未来）IM bot
            │
Agent 层   ReAct 编排(对话) + 确定性流程 DAG 调度 + WriteGate(双执行形态,设计参考 T 系统)
            │
领域层     TripState(长程状态) · 可行性引擎 · 记忆(动机画像/偏好/历史)
            │
能力层     原子能力(尽量复用 hotel-be):
            城市搜索 · 酒店搜索/详情/静态数据 · 地理映射   ← hotel-be
            机票/活动/POI/天气/签证 📍                     ← 外部供应商与公开数据
```

### 7.2 Dual Execution Modes (Borrowed from T-System Production Practice)

The division of labor proven by a production-grade business-travel agent (the T system) migrates directly to the leisure-travel domain:

- **ReAct orchestration side (tool loop)**: natural-language orchestration, open-ended explanation, motivation interviews, spontaneous inquiries—all exploratory, explanatory, low-risk conversation.
- **Deterministic DAG scheduling side**: high-confidence, strong-process, strong-confirmation scenarios—booking confirmation, payment, changes/refunds, itinerary finalization. Supports pending state: after a confirmation is initiated, suspend and wait for the user's explicit reply in the next turn before advancing.
- **Routing principle**: conversation and exploration go to Pure; transactions and state machines go to Graph; boundary scenarios (the user digresses with a question mid-confirmation) are handled by Graph suspending, Pure taking over, and returning after the answer.

### 7.3 Tool Layer

- Domain operations (trip/day/place/budget/booking/…) are structured as **tools with schemas and fine-grained scopes**—borrowing TREK's "the application as the body, AI as the use": model domain operations cleanly first, and only then does the agent have reliable hands and feet.
- Tools return **structured evidence** (source, fetch time, confidence) for direct consumption by the transparency layer (Chapter 6)—transparency is designed from the tool layer up, not patched on at the presentation layer.
- **tool-owned dates** (T-system practice): dates/times are always parsed by tools; the model passes the user's original words verbatim, eliminating low-level accidents like the LLM miscalculating dates.
- Resumable long sessions: streaming output + reconnection resume + server-side session state (the SSE + persistence pattern proven in the T system).

### 7.4 WriteGate

- Read tools (search, query, verification): execute directly.
- Write tools (booking, payment, changes/refunds, messaging third parties): **explicit confirmation required**; tools not proven read-only are treated as writes by default.
- Idempotency keys: duplicate submissions within the same confirmation context take effect only once.
- This is the engineering of red line 5: any model hallucination/misjudgment hits the gate, not the user's wallet.

### 7.5 Feasibility Engine (The Anti-Hallucination Core)

```
自然语言约束/偏好
   │ LLM 抽取(强模型)
   ▼
结构化约束:时间窗(开放时刻/日照) · 门到门交通(班次/前置缓冲/接驳/到达状态,6.5) ·
           预算(总/分项) · 体力(每日有效时长/移动上限/生物钟代价) · 偏好(饮食/文化) · 签证 📍
   │ 确定性求解(规则引擎/调度求解)
   ▼
可行行程(或)unsat core(冲突约束集)
   │ LLM 翻译(强模型)
   ▼
自然语言行程 / 最小修改建议("加 ¥300 / 换日期 / 删一项,任选其一可解")
```

- Basis: on the TravelPlanner benchmark, pure LLM (sole-planning) feasibility is 4.4% (GPT-4)/10% (o1-preview); the LLM + formal-solving hybrid architecture reaches 93%+ (Appendix A-6).
- **Failure is also a product**: the engine never returns "cannot plan" but a minimal change set with reasons—this is where the value "help the user solve problems" lands at the algorithm layer.
- Motivation (4.2) enters the engine as constraints: for the same three days and two nights, "escape and recovery" and "challenge and achievement" solve to completely different itinerary densities. Motivation also sets the **money-time-energy exchange rate** (6.5): under a recovery-type motivation, a door-to-door arrangement with a pre-dawn wake-up plus multiple transfer legs gets flagged "conflicts with the departure motivation"—without solving "why depart", the engine does not even know what to price in.

### 7.6 Long-Horizon State and Memory (Borrowed from loopx + ai-agent-book)

**TripState = the long-horizon task state of one trip** (a trip runs from aspiration to memory, on a cycle measured in weeks/months, far beyond one session):

- objective: motivation profile + constraint set
- phase: current position within the seven stages (Chapter 5)
- gates: explicit gates needing user judgment—itinerary finalization, booking confirmation, payment (borrowing loopx's user gate pattern: ask one concrete question and wait, rather than a vague "waiting for the user")
- evidence: price snapshots, feasibility-verification records, the full context of every transaction—supports after-the-fact review and dispute arbitration
- quota: the iteration budget of a single planning session—**spend only after verification; iterations without effective progress stop silently** (loopx's quota-gated tick pattern, key to consumer-side cost governance)

**Memory layering** (the framework from ai-agent-book Chapter 3):

| Layer | Lifetime | Content | Transparency mechanism |
|---|---|---|---|
| Motivation profile | Cross-year | Motivation spectrum, physical tier, budget tier | Visible/editable (red line 6) |
| Preferences and taboos | Long-term | Diet, lodging habits, companion profiles | Visible/editable |
| Trip state | Weeks to months | Current TripState | Fully visible |
| Conversation context | Within session | Current conversation | Stored compressed; no cross-layer pollution |

Privacy stance: memory belongs to the user; "next departure" personalization uses only the motivation profile and aggregated behavior, never raw conversation text.

### 7.7 Cost Engineering (The Premise of Consumer-Side Economics)

Research baseline: an un-engineered agent session costs 6-10x an engineered one (Appendix A-7). GoTry builds in five levers from Day 1:

| Lever | GoTry's practice | Industry-measured magnitude |
|---|---|---|
| Model tier routing | Strong models for intent understanding/itinerary orchestration/translation and explanation; light models for parameter extraction/formatting/verification/classification | Save 40-70% |
| Context compression | Itinerary state stored structured, conversation history loaded on demand; verbatim deletion preferred over summarization | Token volume down 50-70% |
| Caching | POI/city static data, fixed-format extraction, (future) prompt cache | Up to 90% saved on hits |
| Batch processing | Nightly price prefetch, batch candidate-itinerary generation, evaluation | A flat 50% |
| quota gate | Per-session iteration cap, silent stop on no progress | Prevents runaway (not saving money—stopping losses) |

Cost target: by end of M1, the direct model cost of one full planning session (including the motivation interview) is measurable and reportable; concrete thresholds are calibrated with the launch market and pricing (Chapter 12). **Cost is a product constraint, not an after-the-fact optimization.**

### 7.8 hotel-be Capability-Reuse Boundary

**Reuse (GoTry does not rebuild)**: city search, hotel search/details/static data, geo-mapping—exposed to GoTry's capability layer as internal APIs/services. This is the direct landing of "reduce the cost of maintaining two stacks".

**No reuse (different domain)**: the enterprise travel domain (trip requests, approval flows, cost centers, travel policies)—GoTry is consumer leisure travel; the domain models differ, and forced reuse would leak enterprise semantics into a consumer product.

**Supply-chain stance**: HotelByte is **one** of GoTry's hotel supply chains, compared head-to-head with external suppliers. The direct application of transparency: **if HotelByte is not the best price, GoTry recommends the better channel all the same** (5.4 rule 2). Architecturally, a multi-supplier abstraction provides isolation, avoiding binding to any single supply chain.

### 7.9 Evaluation (eval-driven)

Evaluation precedes feature rollout. Three evaluation sets (following the T system's practice of an independent eval-set repository, name anonymized):

| Eval set | Measures | Baseline target (M1) |
|---|---|---|
| Feasibility | Constraint-satisfaction pass rate (time/geography/budget/stamina) | ≥ 80% (evolving toward 93%+) |
| Factuality | POI existence hallucination rate, price-range deviation | Hallucination < 1% |
| Transparency | Recommendation-card field completeness, commission-disclosure coverage, ranking-factor explainability | 100% / 100% / 100% |

Every prompt, model, or tool change runs regression; cost (token spend per case) is included in the report as a fourth dimension.

---

## 8. Business Model

Three revenue layers, all coexisting with transparency:

1. **Free: planning and companionship**. Motivation interview, planning, on-the-road companionship, memory settling—free, with no degraded experience. This is the entry point of trust; "planning is free" is also a customer-acquisition-cost advantage.
2. **GoTry Plus subscription** (anchored at $49/year, priced per market and fiat currency 📍). Unlocks: parallel multi-plan comparison and long-haul multi-leg planning, price monitoring and window alerts, deeper cross-year memory and annual travel review. Subscription revenue does not depend on transactions and has no conflict of interest with "recommendations you can trust".
3. **Booking commissions**. From M3; transaction share under full disclosure (6.2); users can always choose non-GoTry channels (5.4).

**Revenue we will never make**: paid ranking, recommendation-feed ads, user-data resale (red lines 2, 6).

**Unit economics**: revenue (subscriptions + disclosed commissions) against costs (post-engineering model costs per 7.7 + supply-chain channel fees + fulfillment support). No transaction revenue is pursued before M3—first accumulate the asset of "recommendations you can trust"; trust is the only compounding interest in this model.

---

## 9. Metrics System

**North Star: next-departure rate** = the share of users who complete a second trip within 12 months.

Why this one: it measures product value (the user actually departed), value fulfillment (service continued to the next trip, 5.7), and business-model health (the basis of subscription renewal and commission repurchase) at the same time. It cannot be gamed—only genuinely serving a full loop well moves this number.

**Process metric tree** (1-2 per stage):

| Stage | Metric | What it measures |
|---|---|---|
| Why depart | Motivation-interview completion rate | Users are willing to be heard |
| Where to go | Candidate adoption rate | The card's persuasion and honesty |
| Planning | Itinerary finalization rate / why expansion rate | Planning value / transparency actually used |
| Booking (M3) | Booking conversion rate / external jump rate | Transaction value / the cost and return of transparency |
| On the road | Share of weekly active users mid-trip | Companionship really happening |
| After returning | Memory completion rate / reconciliation open rate / **experience reflux rate** (settling→sharing conversion) | Loop honored and the reciprocity flywheel |
| Next departure | Proactive follow-up acceptance rate | Restraint in outreach recognized |

**Counter-metrics (health guardrails)**: sales-push complaint rate, POI hallucination incident count, share of editorial placements in recommendations (must stay 0), undisclosed-earnings transaction count (must stay 0).

---

## 10. Roadmap

Each stage is an **independently verifiable minimal closed loop**, evaluation first (7.9).

### M1 (Months 0-3): Get Planning Right

Scope: motivation interview; planning dialogue; structured itinerary page (Day planner + map + budget); transparent recommendation cards (the full four parts of 6.1); feasibility engine v1 (time + geography + budget); the three-piece evaluation baseline. **No booking, lightweight accounts.**

Acceptance: feasibility pass rate ≥ 80%; POI hallucination < 1%; seed users (invite-only, 50-200 people) itinerary finalization rate ≥ 40%; NPS ≥ 40; per-session model cost measurable and reportable.

### M2 (Months 3-6): Remember You + On the Road

Scope: memory system (motivation profile/preferences); mid-trip companionship (live conditions, delay rescheduling, same-day tuning); price monitoring; memory settling v1 (memory page + expense reconciliation).

Acceptance: returning users' planning time down ≥ 50% vs first visit (evidence that memory works); mid-trip share of weekly active users ≥ 60%; reconciliation open rate ≥ 30%.

### M3 (Months 6-12): Closing the Loop

Scope: booking (WriteGate + supply-chain integration: hotels via HotelByte compared with external channels, flights/activities external 📍); commission disclosure live; "next departure" proactive follow-up; GoTry Plus subscription launch.

Acceptance: zero misoperation incidents in the booking-confirmation flow (WriteGate effectiveness); a reportable baseline for next-departure rate; the unit-economics model calibrated with measured data.

---

## 11. Risks and Responses

1. **Real-time data and hallucination** (highest technical risk): 7.5 feasibility engine + 6.3 evidence chain + red line 4 existence verification; hallucination incidents go into counter-metrics and, once occurred, into root-cause review.
2. **Supply-chain bargaining power** (a startup with small volume can't get good prices): M1/M2 do not depend on transactions; the price-comparison-and-jump model first proves "recommendations you can trust"; HotelByte is integrated first to lower hotel-side cold start 📍.
3. **Giant competition** (Expedia doubling down after acquiring Layla; the Ctrip family AI-ifying): structural difference—the giants' commission+advertising model cannot go fully transparent (full transparency equals self-revolution), and GoTry carries no such baggage; focus on the "motivation understanding → long-term companionship" segment the giants have no motivation to cover; giants are strong in transaction efficiency, weak in relationships.
4. **Model cost runaway**: 7.7's five levers + quota gate; cost enters evaluation as the fourth dimension; "no progress, no burn" is written into the architecture, not an operations manual.
5. **Trust cold start** ("why should I believe you're transparent"): auditable mechanisms (every card verifiable, every earning checkable) + invite-only seed users + disclosure standards reviewable by independent third parties.
6. **Scaling risk of the "travel philosophy"** (can human care be standardized): the motivation taxonomy is a finite set + continuous weights; personalization relies on constraint solving and memory, not infinitely long dialogue—the floor of depth is guaranteed by the engine, the ceiling is provided by conversation.
7. **Compliance 📍**: commission-disclosure standards, payments/foreign exchange, cross-border data, privacy regulations for automated outreach—confirmed item by item with market lock (Chapter 12).
8. **Cold start and pollution of shared experience**: before the reflux loop spins up, data is thin; after it spins up, astroturfers and merchants pollute → confidence model (corroboration + time decay) + degradation where a single source hints but never grounds + manual seeding (6.6); pollution defense shares its root with the "never sell ranking" red line.

---

## 12. Open Items

| # | Item | Scope of impact | Suggested decision time |
|---|---|---|---|
| 1 | Launch market lock (China outbound / domestic in-depth / global English) | All 📍 items in this document | Before M1 launch |
| 2 | Product form: App first or Web first | M1 scope and team composition | M1 design phase |
| 3 | Exposure form of hotel-be atomic capabilities (direct API / standalone service / SDK) | Architecture and integration cost | M1 design phase |
| 4 | Flight/activity supply-chain selection | M3 | Mid-M2 |
| 5 | Compliance scope and format of commission disclosure | Business-model legality | After market lock |
| 6 | Subscription pricing and the free/paid boundary | Revenue model | Before M3 |
| 7 | Frequency control and defaults for proactive outreach ("next departure") | Experience and privacy compliance | Before M2 |
| 8 | Team and budget | Everything | Immediately |

---

## Appendix A: Reference Projects and Source Mapping

| # | Reference | What it is | What GoTry borrows |
|---|---|---|---|
| 1 | [layla.ai](https://layla.ai/) | Commercial AI travel planning (Berlin, ~25 people; acquired by Expedia in 2026-07); freemium + $49/year; AI+human hybrid | Category and pricing anchor; **counterexample**: chat-only, missing maps/overview/guided flow (Trustpilot/Reddit user tests) → the basis for GoTry's structured itineraries. Sources: layla.ai, Skift 2026-07-31 report, Expedia IR, Trustpilot |
| 2 | [liketrek/TREK](https://github.com/liketrek/TREK) | Open-source self-hosted travel planner (NestJS+React; AGPL v3); 150+ MCP tools, fine-grained scopes, rate limiting | "The application as the body, AI as the use": domain operations toolified + permission model; feature checklist (maps/drag-and-drop/import/collaboration); **code not directly commercially usable (AGPL)** |
| 3 | [huangruiteng/loopx](https://github.com/huangruiteng/loopx) (zread page timed out; read the GitHub README) | Long-horizon task-state kernel and local control plane: objective/gates/todos/evidence/quota; "spend only after verification" | TripState long-horizon state model (7.6): explicit user gates, evidence, quota-gated loop (consumer-side cost governance) |
| 4 | An enterprise-grade business-travel Agent system (the T system, in production, source anonymized) | ReAct orchestration + deterministic DAG dual execution, WriteGate, tool-owned dates, SSE reconnection resume, internal eval system, independent eval sets | 7.2 dual execution modes, 7.3 tool-layer practices, 7.4 WriteGate, 7.9 evaluation forms—direct migration of production-proven practice |
| 5 | [bojieli/ai-agent-book](https://github.com/bojieli/ai-agent-book) | The open-source book "Understanding AI Agents in Depth" (深入理解 AI Agent): context engineering, memory, tools/MCP, evaluation, multi-agent; "Harness engineering is the real competitiveness" | 7.6 memory-layering framework, 7.7 context compression, 7.9 eval-driven methodology |
| 6 | [Reading the travel-planning AI Agent papers (Zhihu)](https://zhuanlan.zhihu.com/p/11161530566) (the WeChat original was blocked; this is the primary source) | Interpretation of the TravelPlanner benchmark + LLM+Z3 hybrid-solving papers | The direct basis for the 7.5 feasibility engine: pure LLM 4.4% vs hybrid 93%+; unsat core → minimal-change suggestions |
| 7 | [Morph: LLM Cost Optimization](https://www.morphllm.com/llm-cost-optimization) (the WeChat original was blocked; this is the primary source) | The five agent-cost levers and measured magnitudes | 7.7 cost engineering: routing 40-70% / compression 50-70% / caching 90% / batching 50% / stacked 84-91% |
| 8 | Multi-source research on industry pain points | TravelDaily (环球旅讯), 21st Century Business Herald (21 财经), Consumer Daily (消费日报), China Tourism News (中国旅游报), etc. | 3.1 problem definition: fragmentation, real-time data, granularity, trust |
| 9 | Xiaohongshu / Yuanzhou Guiji (圆周轨迹) (founder's usage experience) | Experience communities: high density of real folk wisdom, but unstructured and must be read by people themselves | Form reference and differentiation target for the 6.6 shared-experience layer; cold start only does manual distillation of factual assertions |

---

## Appendix B: Relationship with the HotelByte / Stai System

**Position: GoTry is an independent consumer product, not a product line of HotelByte/Stai.** hotel-be's value to GoTry is two things: an atomic-capability foundation + a ready-made hotel supply chain.

- **Reuse list**: city search, hotel search/details/static data, geo-mapping (7.8). Principle: don't rebuild what can be reused; reduce the cost of maintaining two stacks.
- **No-reuse list**: the enterprise travel domain (requests/approvals/cost centers)—different domain, no forced coupling.
- **Boundary with Stai BP**: Stai's hard boundary is "no end guests" (a pure B2B distribution marketplace); GoTry is precisely consumer-facing—the two neither conflict nor overlap. If the Stai marketplace matures in the future, GoTry can become one of its consumer-side entries, but this is **not a design premise of GoTry**.
- **Architectural hedge**: GoTry accesses hotel inventory through a multi-supplier abstraction; HotelByte is one of them, not the only one—changes in a single supply chain's pricing power or availability do not affect product survival.
