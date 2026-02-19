# NovoHaven Web Test User Stories

## Notes
- Sources: `README.md`, `.claude/plans/2026-02-16-gateway-agent-platform.md`, actual codebase routes and plugin implementations
- These stories are written to be directly translated into automated web tests.
- Agent tools available: `skill_search`, `skill_execute`, `skill_test`, `skill_edit`, `skill_create`, `skill_validate`, `browser:navigate`, `browser:interact`, `browser:screenshot`, `bash:execute`, `file:read`, `file:write`, `file:list`

## Reusable Test Data (Fixtures)

### `review_data.csv`
```csv
rating,title,review
5,Great kettle,"Boils in 3 minutes and looks premium."
2,Stopped working,"Stopped heating after 2 weeks."
4,Good value,"Fast boil and easy to clean."
```

### `requirements.json`
```json
{
  "background": "clean white seamless",
  "lighting": "soft daylight, low shadow",
  "angle": "45-degree hero shot",
  "style": "minimal premium e-commerce",
  "aspect_ratio": "1:1"
}
```

### `agent_note.txt`
```txt
Please summarize the top 3 customer pain points from this file.
```

### Shared Input Values
- `product_name = "AeroBrew Coffee Grinder"`
- `target_audience = "Home baristas in small apartments"`
- `analysis_focus = "durability, noise, value for money"`
- `workflow_name = "Listing + Review Pipeline"`

## Happy-Path User Stories

### HP-01
User lands on `/` and is auto-authenticated. User sees sidebar brand `NovoHaven`, nav links (`Dashboard`, `Agent Chat`, `New Skill`, etc.), and footer user `demo@novohaven.com` with `Demo Account`. No login form is shown.

### HP-02
User toggles language from sidebar on `/`. User clicks `Language` toggle once; expects badge changes from `EN` to `中文` and page strings change to Chinese (for example dashboard title becomes `仪表板`). User refreshes page; expects Chinese remains (localStorage persistence). User toggles again; English returns.

### HP-03
User verifies dashboard navigation cards on `/`. User sees health cards (`Active Sessions`, `Pending Drafts`, `Skills`, `Workflows`) and `Build with AI` card. User clicks `Build with AI` card (or `Get Started` button); expects navigation to `/workflows/ai-builder`.

### HP-04
User creates a new AI skill at `/skills/new`. User enters name `QA Listing Writer`, description `Generate concise Amazon listing copy`, prompt `Write a 5-bullet listing for {{product_name}} for {{target_audience}}.`, output format `Markdown`, temperature `0.3`, max tokens `1200`. User clicks `Create Skill`; expects redirect to `/` and new card visible under `My Skills` titled `QA Listing Writer`.

### HP-05
User configures variables in skill editor at `/skills/:id`. User opens `Input Variables`, adds variable `product_name` (type: text, required) and `target_audience` (type: text, required), sets labels `Product Name` and `Target Audience`, clicks save. User reopens skill; expects prompt still contains `{{product_name}}` and `{{target_audience}}`, and configured labels persist.

### HP-06
User runs a skill from `/skills/:id` with valid inputs. User clicks `Run`, enters `AeroBrew Coffee Grinder` and `Home baristas in small apartments`, clicks `Run` in modal; expects navigation to `/executions/{id}`.

### HP-07
User creates a workflow at `/workflows/new`. User enters workflow name `Listing + Review Pipeline`, description `Generate listing then summarize review pain points`, clicks `Add Step`, selects `QA Listing Writer`, saves. User expects workflow editor persists and route is `/workflows/{id}`.

### HP-08
User edits workflow steps at `/workflows/:id`. User selects step, changes step name to `Listing Draft Step`, uses move-down/up controls, then clicks `Save Changes`. User reloads page; expects step order and renamed step persist.

### HP-09
User runs workflow with input values at `/workflows/:id/run`. User sees `Input Values` section with required fields, enters `product_name` and `target_audience`, clicks `Start Workflow`. User expects redirect to `/executions/{id}` and execution header showing `Execution #{id}`.

### HP-10
User monitors executions at `/executions`. User sees execution row with status pill, workflow name, and progress text like `1 / 1 steps`. User clicks row; expects open `/executions/{id}`.

### HP-11
User cancels a running execution at `/executions`. User clicks cancel icon on running row; expects status changes to `cancelled` after refresh.

### HP-12
User deletes an execution at `/executions`. User clicks trash icon on one row, sees modal `Delete Execution`, clicks `Delete`; expects row removed from list.

### HP-13
User reviews execution chat details at `/executions/:id`. User sees step/system/output messages. On an output message, user clicks `Copy`; expects button text changes to `Copied!` briefly. If execution completes, user sees status badge `completed`.

### HP-14
User chats with agent at `/chat`. User clicks `+ New Chat`, types `Summarize three benefits of stainless steel water bottles.` and presses Enter. User expects own message bubble immediately, session appears in sidebar with title starting from prompt text, and assistant response streams in token by token. Final assistant message bubble is shown.

### HP-15
User sends image attachment in agent chat at `/chat`. User clicks attachment icon, uploads a product image (`product.png`), types `Describe this image`, clicks send. User expects image thumbnail shown in user bubble. Agent response should acknowledge the image content (multimodal vision). Session remains active.

### HP-16
User manages chat sessions in `/chat`. User clicks `Clear all chats`; expects sidebar session list clears and empty state `No conversations yet` appears. User can also delete individual sessions via the X button on hover.

### HP-16b
User navigates away from `/chat` to another page, then returns to `/chat`. User expects sidebar still shows previous sessions, and selecting a session loads its full message history (user and assistant messages restored from server).

### HP-17
User monitors sessions at `/sessions`. User sees table columns (`Session ID`, `Channel`, `Status`, `User`, `Last Active`, `Messages`). User clicks a row; expects transcript panel expands with user/assistant bubbles. User clicks `Close`; expects row status becomes `closed`.

### HP-18
User manages plugins at `/plugins`. User expands `Browser Automation` plugin, changes `timeout` from `30000` to `45000`, clicks `Save Config`; collapses and reopens, expects value `45000` persists. User toggles plugin enabled switch off then on; expects switch state updates without page error.

### HP-19
User reviews skill drafts at `/drafts` (seed at least one draft). User sees draft table with `Name`, `Type`, `Change Summary`, `Created`. User clicks row; expects expanded comparison (`Original` vs `Proposed Changes`). User clicks `Approve`; expects draft disappears from list and the corresponding skill/workflow is updated with the proposed changes.

### HP-20
User browses generated outputs at `/outputs`. User clicks `Text`, `Markdown`, `JSON`, `Images`, `Files` tabs and sees count badges update. User opens one output card; expects modal with `Workflow`, `Model`, `Executed` metadata. User clicks `Download Text` (or `Download JSON` / `Download Markdown`); expects file download starts. User clicks `View Execution`; expects navigation to `/executions/{executionId}`.

### HP-21
User manages company standards at `/standards`. User clicks `Add Standard` and creates:
- `Name: Brand Voice - Ecommerce`
- `Type: Brand Voice`
- `Tone: Professional yet approachable`
- `Style: Benefit-first, concise`
- `Guidelines: "Use active voice", "Lead with customer value"`
User clicks `Create Standard`; expects new card appears in `Brand Voice` tab showing tone/style/guidelines. User clicks `Edit`, updates tone to `Friendly expert`, saves, sees updated value. User clicks `Delete`, confirms, and card is removed.

### HP-22
User checks usage analytics at `/usage`. User sees `Usage Dashboard` with `Overview` and `History` tabs. In `Overview`, user sees period cards (`Today`, `This Week`, `This Month`) and service breakdown rows. User clicks `History`; expects table with `Date`, `Service`, `Endpoint`, `Requests`, `Records`.

### HP-23
User builds workflow via AI assistant at `/workflows/ai-builder` (requires at least one configured AI provider model). User enters `Create a 2-step workflow: research electric kettles, then draft an Amazon listing.`, clicks `Send`. User expects assistant chat response and right-side `Workflow Preview` populated with name/description/steps. User edits first step name to `Kettle Research`, clicks `Save as Workflow`; expects navigation to `/workflows/{id}`.

### HP-24
User selects a different LLM model in agent chat at `/chat`. User clicks the model dropdown in the chat header, selects a different model (e.g., switches from Claude Sonnet to Gemini). User expects a new session starts automatically (because provider changes require a new agent process). User sends a message and receives a response from the newly selected model.

### HP-25 — Agent suggests existing skills/workflows
User verifies relevant existing-skill/workflow recommendation in `/chat`. Preconditions: user already has a skill named `Product Review Analyzer` and a workflow named `Listing + Review Pipeline`. User sends `I need to analyze customer reviews for my new kettle listing.` Agent should use `skill_search` to find matching assets and suggest one or both by exact name and ID (e.g., `[skill #3] Product Review Analyzer`). Agent should list the required inputs with their types (e.g., `{{review_data}} (file)`, `{{analysis_focus}} (text, optional)`). Agent should NOT propose building something from scratch when a matching skill exists.

### HP-26 — Agent collects required inputs, skips optional, and executes
User verifies required-input collection and execution after skill suggestion in `/chat`. Preconditions: `Product Review Analyzer` has required inputs `review_data` (type: file) and optional `analysis_focus` (type: text). User sends `Run Product Review Analyzer`. Agent should ask only for the required input `review_data` and indicate that `analysis_focus` is optional (can be skipped). User replies with `review_data.csv` attachment only (no analysis_focus provided). Agent should proceed to execute the skill via `skill_execute` without re-asking for the optional input. User should see execution confirmation in chat and a new execution created in `/executions`.

### HP-26b — Agent passes image attachments to skill execution
Preconditions: a skill named `Image Style Analyzer` exists with required input `reference_image` (type: image). In `/chat`, user uploads a product image and sends `Analyze the style of this image`. Agent should use `skill_search` to find `Image Style Analyzer`, recognize that the uploaded image maps to the `reference_image` input, and call `skill_execute` with `imageInputs: {"reference_image": 0}` (mapping the variable to the first attachment). Agent should NOT ask the user to re-upload the image.

### HP-27 — Agent self-heals a broken skill
User verifies agent self-heals a broken skill and submits draft for review. Preconditions: create a broken skill named `Broken Sentiment Skill` with unresolved variable like `{{missing_column}}` in prompt. In `/chat`, user asks `Run Broken Sentiment Skill and fix it if it fails.` Agent should first use `skill_validate` or `skill_test` to diagnose the issue, then use `skill_edit` to propose a fix (creating a draft with a clear `changeSummary`). Agent response should mention the draft was created. In `/drafts`, user should see a new pending draft for that skill with change summary explaining the fix.

### HP-28 — Agent self-heals a broken workflow
User verifies agent self-heals a broken workflow and submits draft for review. Preconditions: create workflow `Broken Pipeline` where step 1 references `{{step_2_output}}` (invalid forward reference). In `/chat`, user asks `Use Broken Pipeline and repair it.` Agent should use `skill_validate` to identify the sequencing error, then use `skill_edit` to submit a corrected workflow draft for review, explaining what changed. In `/drafts`, user should see a pending workflow draft. After approve, running the workflow from `/workflows/:id/run` should no longer fail for the original ordering issue.

### HP-29 — AI Workflow Builder self-correction
User verifies AI Workflow Builder self-healing loop at `/workflows/ai-builder`. User asks assistant to create a workflow, then intentionally requests a breaking change: `Now rewrite this so step 1 uses {{step_3_output}} and remove required inputs.` Assistant should correct itself on follow-up (repair invalid variable chain and restore needed inputs), update right-side `Workflow Preview`, and produce a runnable workflow that can be saved and started without structural validation failure.

### HP-30 — Agent uses browser tools to navigate a user-provided URL
In `/chat`, user sends `Go to https://www.example.com/products and tell me what products are listed there.` Agent should call `browser:navigate` with the provided URL, receive the page content, and summarize the products found on the page. The response should include specific content from the URL, not a generic answer. If the page requires interaction (e.g., scrolling, clicking "Load More"), agent should use `browser:interact` to get additional content.

### HP-31 — Agent uses browser to extract structured data from a website
In `/chat`, user sends `Search for 'smart furniture' on Amazon and save the top 10 results in a CSV file with each result's name, price, main features, and review score.` Agent should:
1. Use `browser:navigate` to go to Amazon and search for the term.
2. Use `browser:interact` / `browser:extract` to scrape the search results.
3. Use `file:write` to create a CSV file with the extracted data.
4. Return the file path or content to the user so they can download the result.
5. After completing the task, use `skill_create` to propose saving this as a new reusable skill (e.g., "Amazon Product Search Scraper") with parameterized inputs (`search_query`, `result_count`). This draft should appear in `/drafts` for human review.

### HP-32 — Agent completes ad-hoc task using tools when no skill exists
In `/chat`, user sends a task for which no existing skill or workflow matches, e.g., `Count the number of H1 and H2 headings on https://www.example.com and write the result to a file.` Agent should:
1. Use `skill_search` first and find no matching skill.
2. Fall back to using available tools directly (`browser:navigate` to fetch page, `bash:execute` or internal logic to parse headings, `file:write` to save results).
3. Return the result to the user in chat.
4. Optionally propose saving the successful task as a new skill via `skill_create` for future reuse.

### HP-33 — Agent returns downloadable file from tool execution
In `/chat`, user sends `Create a JSON file with 5 sample product entries (name, price, category) and give me the file.` Agent should use `file:write` to create the JSON file, then provide the file path or content in the chat response so the user can access or download it.

### HP-34 — Agent handles multi-step workflow with mixed tool usage
In `/chat`, user sends `Find the top 3 trending articles on Hacker News, summarize each in one sentence, and save the summaries as a markdown file.` Agent should:
1. Use `browser:navigate` to open Hacker News.
2. Use `browser:interact` to extract article titles and links.
3. Use `browser:navigate` on each article link to get content.
4. Use the LLM to summarize each article.
5. Use `file:write` to create a markdown file with the summaries.
6. Return the result in chat.

### HP-35 — Manus task execution
User runs Manus task when configured at `/manus`. User enters prompt `Find top 5 ergonomic office chairs under $300 and summarize pros/cons.`, clicks `Start Task`; expects navigation to `/executions/{id}`.

## Error / Edge-Case User Stories

### EE-01
User validates required-input behavior in skill run modal at `/skills/:id`. User clicks `Run`, leaves fields empty, clicks `Run`; expects inline error starting with `Please fill in all required fields`.

### EE-02
User validates Manus unconfigured state at `/manus`. If `MANUS_API_KEY` is missing, user sees red not-configured badge and message explaining Manus is not configured.

### EE-03
User validates 404 handling. User opens `/not-a-real-page`; expects `Page Not Found` and text `The page you're looking for doesn't exist.`

### EE-04
User sends message in `/chat` with no LLM provider configured (all provider plugins disabled or no API keys). Agent should return an error message: `No LLM provider available. Please configure an API key.` rather than crashing.

### EE-05
User sends a very long message in `/chat` (over 10,000 characters). Agent should still process it without truncation errors. The message should appear in the user bubble (may be scrollable) and the agent should respond normally.

### EE-06
Agent reaches maximum tool execution rounds (10) in `/chat`. User sends a request that causes the agent to loop through tool calls repeatedly. After 10 rounds, agent should respond with `Reached maximum tool execution rounds. Please try a simpler request.` rather than hanging.

### EE-07
Browser tool fails in `/chat`. User sends `Go to https://this-domain-does-not-exist-12345.com`. Agent calls `browser:navigate` which fails. Agent should report the error gracefully (e.g., `Browser error: net::ERR_NAME_NOT_RESOLVED`) and not crash the session. User can continue chatting.

### EE-08
Agent attempts to use a tool from a disabled plugin. If `tool-browser` is disabled in `/plugins`, and user asks the agent to browse a URL, agent should indicate it cannot access browser tools rather than erroring silently.

## Priority Tags (Automation Planning)

### Priority Levels
- `P0`: must-run on every CI pass (critical user paths)
- `P1`: important regression coverage (daily/nightly)
- `P2`: lower-risk or admin/diagnostic flows (scheduled)

### Priority Matrix

| Story ID | Priority | Why |
|---|---|---|
| HP-01 | P0 | App boot/auth baseline |
| HP-02 | P1 | i18n persistence |
| HP-03 | P1 | Dashboard navigation entry points |
| HP-04 | P0 | Core skill creation |
| HP-05 | P1 | Variable config persistence |
| HP-06 | P0 | Skill execution launch |
| HP-07 | P0 | Core workflow creation |
| HP-08 | P1 | Workflow edit persistence |
| HP-09 | P0 | Workflow run start |
| HP-10 | P0 | Execution visibility |
| HP-11 | P1 | Execution control action |
| HP-12 | P1 | Execution deletion control |
| HP-13 | P1 | Execution detail rendering |
| HP-14 | P0 | Agent chat send/receive + streaming |
| HP-15 | P1 | Chat image attachment + multimodal vision |
| HP-16 | P2 | Chat session cleanup (bulk + individual) |
| HP-16b | P1 | Chat history persistence across navigation |
| HP-17 | P2 | Session monitor admin flow |
| HP-18 | P2 | Plugin manager admin flow |
| HP-19 | P2 | Draft review admin flow |
| HP-20 | P1 | Output gallery + downloads |
| HP-21 | P1 | Standards CRUD |
| HP-22 | P2 | Usage analytics |
| HP-23 | P1 | AI builder workflow generation |
| HP-24 | P1 | LLM model switching in agent chat |
| HP-25 | P0 | Agent reuses existing skills, shows required inputs with types |
| HP-26 | P0 | Agent collects required inputs, skips optional, executes skill |
| HP-26b | P0 | Agent maps uploaded images to skill image inputs automatically |
| HP-27 | P1 | Agent self-healing for broken skill via validate + edit draft |
| HP-28 | P1 | Agent self-healing for broken workflow via validate + edit draft |
| HP-29 | P1 | AI builder iterative self-correction before save/run |
| HP-30 | P0 | Agent uses browser tools to navigate user-provided URLs |
| HP-31 | P0 | Agent scrapes structured data, saves to file, proposes new skill |
| HP-32 | P1 | Agent completes ad-hoc tasks using tools when no skill matches |
| HP-33 | P1 | Agent creates and returns downloadable files |
| HP-34 | P1 | Agent handles complex multi-step browser + file tool chains |
| HP-35 | P2 | Manus configured flow |
| EE-01 | P0 | Required-field validation |
| EE-02 | P2 | Manus unconfigured guardrail |
| EE-03 | P1 | 404 route fallback |
| EE-04 | P0 | No provider configured error handling |
| EE-05 | P1 | Long message handling |
| EE-06 | P1 | Max tool rounds graceful stop |
| EE-07 | P1 | Browser tool failure resilience |
| EE-08 | P1 | Disabled plugin tool unavailability |
