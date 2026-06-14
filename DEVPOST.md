# DueProcess — answer your eviction in time, not in the dark

**Track:** AI × Social Good (Equity & Justice). **Not a lawyer. Not legal advice.**

## The problem

Eviction court is lopsided. Across the U.S., landlords have a lawyer in the large majority
of cases (commonly reported around **80%**); tenants almost never do (often cited at
roughly **3%**). A California tenant served with a Summons + Complaint for unlawful
detainer must file a written Answer within a hard, short deadline or lose by **default
judgment** — frequently without ever being heard.

And the rule just changed. **AB 2347** amended Code of Civil Procedure § 1167 (effective
2025-01-01) to give tenants **10 court days** to respond — double the old **5-day** window.
Most web pages, and most LLMs trained before the change, still confidently give the
**stale 5-day answer**. For a deadline you can't miss, that error is the whole ballgame.

## What it does

DueProcess turns court papers into a plan: (1) **read** the notice from a photo or
description, in the user's language; (2) **compute** the response deadline; (3) **answer**
rights questions using only cited California sources — or **refuse** when unsure; (4)
**draft** the Answer (UD-105); (5) **hand off** to a legal-aid clinic. It can prepare a
draft and hand you off — it **never files your case**.

## How we keep it honest

A hard split: **LLMs do perception and synthesis; deterministic code does anything legally
consequential.** The deadline is computed in pure code (CCP § 1167 / AB 2347, court-day +
California-holiday math) — the model never sets the date. Answers are **cite-or-abstain**:
citations are rebuilt in code from retrieved sources, so a citation can only be a real
indexed URL, and any answer that ends up uncited is downgraded to a refusal.

## Architecture

One Next.js app on **Cloudflare Workers** (OpenNext): **Workers AI** (Llama 4 Scout vision;
Kimi K2.6 / gpt-oss-120b reasoning), **AI Search** for RAG over current CA `.gov` sources,
**D1 / R2 / Durable Objects** for state + a deadline-reminder alarm, and mem0 case memory.

## Did we test it? Yes — the test DoNotPay never ran

Controlled `reglab/housing_qa` RAG eval, 50 California questions, against the real grounding
pipeline on a throwaway corpus: **answer accuracy 0.65**, **abstention rate 0.60** (correctly
refusing **7/10** genuinely out-of-corpus questions), citation hit-rate@5 **0.24**. The
pipeline is deliberately conservative — it would rather refuse than guess.

## Honest limitations

**California only.** Documents are **unsigned drafts**, not filings. **Not legal advice;
not a lawyer.** The eval dataset is accurate only **as of 2021** and is multi-state, so
those numbers measure pipeline faithfulness against a controlled corpus, not today's CA
law. The eval run used the fallback model after the primary hit capacity limits.

## AI disclosure

Built with AI coding assistants (Devin / Claude) under human direction; uses Workers AI +
AI Search at runtime. Every legally consequential step is deterministic code, and the eval
numbers were produced by code, not written by hand.
