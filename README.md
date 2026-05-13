# NSAI — NetSuite AI Assistants (Open Source)

Two NetSuite AI assistants — **Record AI** (an in-record floating chat panel
that answers questions about the record you are looking at) and **Search
Insight** (a saved-search analyzer that produces narrative AI commentary with
clickable record links) — backed by a shared **common** SDF project that holds
the LLM provider / model / defaults registries, the **AI** center tab, and the
**AI Setting** center category.

Pure SuiteScript 2.1 + SDF XML. No Node tooling, no Python, no external
runtime. License: Apache-2.0.

---

## Repository layout

```
common/           shared LLM provider / model / defaults registries,
                  AI center tab, AI Setting center category. Required.
record_ai/        Record AI: per-record contextual Q&A (floating panel).
search_insight/   Search Insight: saved-search analyzer.
LICENSE
README.md
.gitignore
```

Each of the three subprojects (`common/`, `record_ai/`, `search_insight/`) is
a complete, standalone SDF Account Customization project with its own
`manifest.xml`, `deploy.xml`, `Objects/`, and (for the two app projects)
`FileCabinet/SuiteScripts/`.

---

## Prerequisites

- A NetSuite account with the following features enabled (Setup → Company →
  Enable Features):
  - **SuiteCloud Development Framework** (SDF)
  - **Custom Records**
  - **Server SuiteScript**
  - Token-Based Authentication (or OAuth 2.0) for the SuiteCloud CLI account
- A role with permission to deploy custom records, scripts, custom lists, and
  center tabs / categories. The **Administrator** role is sufficient.
- One of:
  - **SuiteCloud CLI for Node.js** —
    `npm install -g @oracle/suitecloud-cli`
  - **SuiteCloud Extension for VS Code** (uses the same CLI under the hood)
- An LLM endpoint you can call from NetSuite, such as:
  - NetSuite's native `N/llm` (provider key `nllm`, no key/URL required)
  - Any OpenAI-compatible chat-completions endpoint (OpenAI, OpenRouter,
    Qwen, DeepSeek, a self-hosted model, etc.)

---

## Deploy order

`record_ai` and `search_insight` declare manifest dependencies on objects
that live in `common`. On a fresh account the deploy order is fixed:

1. `common` — provides the AI center tab, AI Setting center category,
   provider / model / defaults custom records, and two custom lists.
2. `record_ai`
3. `search_insight`

`record_ai` and `search_insight` are independent of each other — you can
deploy one and skip the other.

---

## Install — option A (three separate SDF projects, recommended)

This is the cleanest install. You end up with three side-by-side SDF
projects in your workspace, each easy to update individually.

For each subproject, in this exact order — `common`, then `record_ai`,
then `search_insight`:

1. Copy the subproject folder (e.g. `common/`) into your SuiteCloud
   workspace as its own project.
2. Open a terminal in that subproject folder (where `manifest.xml` lives),
   then run:

   ```bash
   suitecloud project:adddependencies
   suitecloud project:deploy
   ```

   The VS Code equivalents are **SuiteCloud: Add Dependencies** followed
   by **SuiteCloud: Deploy Project**.

3. Wait for the deploy to complete successfully before moving to the next
   subproject.

---

## Install — option B (merge into your existing SDF project)

If you already have an SDF project for the target account and prefer a
single deploy, you can merge all three subprojects into it:

1. Copy each subproject's `Objects/*.xml` into your project's `Objects/`
   directory.
2. Copy each subproject's `FileCabinet/SuiteScripts/*` into your project's
   `FileCabinet/SuiteScripts/` directory. (`common` has no
   `FileCabinet/` — it's objects-only.)
3. Merge each subproject's `manifest.xml` `<dependencies>` block into your
   project's `manifest.xml`. The `<features>` and `<objects>` lists from
   `record_ai` and `search_insight` reference objects that come from
   `common`; make sure all three contribute.
4. Run **Add Dependencies** and **Deploy Project** once.

---

## First-run configuration

The `common` project ships three seed rows so a fresh account boots with
a working default LLM configuration:

| Record                     | Seed value                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| `customrecord_ai_provider` | provider name `nllm`, API key and URL = `na`                       |
| `customrecord_ai_models`   | model `COHERE_COMMAND_LATEST`, parented to `nllm`                  |
| `customrecord_ai_defaults` | default provider = `nllm`, default model = `COHERE_COMMAND_LATEST` |

The `nllm` seed is a placeholder pointing at NetSuite's native `N/llm`
module, which does not require an API key or URL — so the seed is safe
to commit and works out of the box on any account where `N/llm` is
available.

To switch to your own LLM:

1. After `common` deploys, open the NetSuite UI:
   **AI → Setting → AI Provider** (top navigation).
2. Click **New AI Provider** and create a new provider row with:
   - **Provider** — a short key (`openrouter`, `openai`, `qwen`, etc.). The
     keys `nllm` and `openrouter` get special handling; everything else is
     treated as a generic OpenAI-compatible chat-completions endpoint.
   - **API Key** — your real API key.
   - **End Point** — the full chat-completions URL
     (e.g. `https://openrouter.ai/api/v1/chat/completions`).
3. Open **AI → Setting → Models**, click **New AI Models**, and add at
   least one model row pointing at the new provider — set
   **Model** to the model identifier the provider expects (e.g.
   `openai/gpt-4o-mini` for OpenRouter).
4. Open **AI → Setting → AI Defaults**, edit the existing **AI Defaults**
   row, and point **Default Provider** and **Default Model** at the new
   rows you just created.

That's it. The Record AI panel and Search Insight will now route through
your provider.

---

## Using the assistants

After deploy, the **AI** center tab appears in the top navigation for
every role.

- **Record AI** — open any record in **View** mode; an **Ask AI** button
  appears in the header. Click it to open the floating, draggable,
  resizable chat panel. The panel keeps per-record conversation memory
  (stored in the File Cabinet under
  `/SuiteScripts/record_ai/logs/`) and exposes tunable temperature,
  top-p, top-k, frequency-penalty, and max-tokens controls.
- **Search Insight** — go to **AI → Search Insight → Search Insight**.
  Pick a saved search, ask a question, and the Map/Reduce processor
  runs the search, sends the rows plus your question to the LLM, and
  returns markdown with `[[Display Name|recordType|id]]` tokens that
  render as live links to the underlying records.

Both apps queue jobs onto custom records (`customrecord_record_ai_job`
and `customrecord_search_insight_job`) and process them in a Map/Reduce
script so long LLM calls do not block the UI. The Suitelet polls for
results.

---

## Adding more providers and models

Always add new providers and models in the **NetSuite UI**, never by
editing the XML directly. SDF treats the three seeded `<instance>` rows
as canonical and **a re-deploy of `common` overwrites those three seed
rows back to their placeholder values** — but it never touches rows that
operators add through the UI.

In other words:

- Operators may add as many extra provider / model / defaults rows as
  they want via the UI; they survive future re-deploys.
- The three seed rows (`nllm` provider, `COHERE_COMMAND_LATEST` model,
  the matching defaults row) are owned by SDF; do not edit them in the UI.
  If you need to change the active provider / model account-wide, add a
  new row instead and update the **AI Defaults** row to point at it.

---

## Caveats and design notes

- **Re-deploys overwrite the three seed rows.** See the previous section.
  Operator-added rows are safe.
- **Some custom field scriptids inside the `customrecord_ai_*` records use
  a `_nai_*` prefix** (`custrecord_nai_secret_provider`,
  `custrecord_nai_secret_key`, `custrecord_nai_secret_url`,
  `custrecord_nai_provider_parent`, `custrecord_nai_model_id`,
  `custrecord_nai_input_price`, `custrecord_nai_output_price`). The
  SuiteScript libraries read and write these field ids by name. **Do not
  rename them** — renaming a custom field scriptid orphans all existing
  row data on any account where the field has been populated.
- **Instance scriptids contain a NetSuite-generated suffix** (the
  `td...` fragment). It is part of the canonical scriptid and can be
  safely ignored — renaming it would force every target account to
  re-resolve the seed rows on next deploy and create duplicate rows.
- **API keys are stored encrypted at rest** (`encryptatrest=T` on
  `custrecord_nai_secret_key`) and the field is marked
  `accesslevel=2` so it is only visible to administrators.
- **Map/Reduce throttling.** The Suitelets create up to 10 secondary
  Map/Reduce deployments named `_record_ai_mr_*` and
  `_search_insight_mr_*` on demand so multiple users can run jobs in
  parallel. They are created automatically the first time they are
  needed; you do not need to create them by hand.

---

## Troubleshooting

| Symptom                                                    | Likely cause                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy fails with missing object errors on the app step    | `common` has not been deployed yet, or the manifest dependencies were not added. Run `suitecloud project:adddependencies` and re-deploy `common` first.                                     |
| Record AI panel opens but errors with "no active provider" | The default provider is inactive or the seeded `nllm` row was deleted. Re-create it via **AI → Setting → AI Provider** or re-deploy `common`.                                               |
| LLM call returns "missing an API key"                      | The active provider is not `nllm` and the API Key field is blank. Edit the provider row in the UI and save your real key.                                                                   |
| Search Insight job stays in `queued` forever               | The Map/Reduce script deployment is paused or out of governance. Check **Customization → Scripting → Script Deployments** for `customscript_search_insight_mr` and ensure it is `Released`. |

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
