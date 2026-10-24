# Kinline — Four Independent AI Agents Architecture

Build Kinline as a mobile-first, installable Progressive Web Application containing **four separate, fully functional AI agents**.

The agents are:

1. Guardian Agent
2. Care Agent
3. Wellness Agent
4. Finance Agent

**Critical requirement: Do NOT implement one chatbot that simply switches between four system prompts.**

Each agent must be an independently instantiated AI agent with its own:

- System prompt and personality
- Domain-specific reasoning and planning
- Dedicated tool registry
- Scoped memory and conversation history
- Independent task execution workflows
- Authorization and safety policies
- Scheduled jobs and event handlers
- Error handling and recovery
- Execution logs and observable activity
- API/service interface
- Dedicated conversational UI

All four agents operate within one Kinline application and share common infrastructure without losing their independence.

## 1. Application Experience

The Kinline home screen should prominently display four interactive agent cards.

**Guardian**
"Stay safe and get help when you need it."

**Care**
"Manage medications, groceries, and everyday care."

**Wellness**
"Talk about your day and stay connected."

**Finance**
"Understand your bills and manage your finances."

Tapping a card opens that agent's dedicated experience.

Each agent page must contain:
- Agent-specific welcome message
- Large microphone button
- Real-time voice conversation
- Text input alternative
- Conversation history
- Suggested voice commands
- Active tasks
- Pending approvals
- Relevant information and status cards

Users should always know which agent they are talking to.

## 2. Agent Runtime Architecture

Implement a reusable BaseAgent interface, with four separate implementations:

- GuardianAgent
- CareAgent
- WellnessAgent
- FinanceAgent

Each agent must implement:

- initialize()
- processMessage()
- processVoiceInput()
- retrieveMemory()
- planTask()
- executeTool()
- requestApproval()
- handleEvent()
- scheduleTask()
- getTaskStatus()

Use real LLM calls and structured tool execution.

Agent prompts and tool permissions must be independently configured.

Do not allow one agent to directly access another agent's private data or execute another agent's tools without an authorized cross-agent workflow.

## 3. Independent Agent Responsibilities

### Guardian Agent

Tools:
- analyzeSuspiciousConversation
- initiateTrustedVerification
- createSecurityIncident
- requestEmergencyAssistance
- notifyTrustedContact
- createHumanAssistanceRequest
- scheduleHelper
- trackAssistanceResponse

### Care Agent

Tools:
- getMedicationSchedule
- sendMedicationReminder
- recordMedicationConfirmation
- preparePharmacyRefill
- createGroceryList
- searchProducts
- createShoppingCart
- requestOrderApproval
- suggestMeals
- updatePantry

### Wellness Agent

Tools:
- startConversationalCheckIn
- extractWellnessObservations
- saveWellnessMemory
- analyzeLongitudinalPatterns
- generateWellnessSummary
- scheduleFollowUp
- requestCaregiverNotification
- arrangeFamilyCall

### Finance Agent

Tools:
- analyzeMedicalBill
- compareInsuranceDocuments
- auditCareFacilityInvoice
- detectRecurringCharges
- analyzeAuthorizedTransactions
- prepareDispute
- requestFinancialApproval
- searchBenefits
- generateCareCostProjection

Every tool must be implemented with real validation, permission checks, execution state, and error handling.

## 4. Agent Memory Isolation

Each agent has dedicated memory namespaces.

Guardian memory:
- Security incidents
- Verification history
- Trusted-contact workflows
- Assistance history

Care memory:
- Medication schedules
- Confirmations
- Grocery preferences
- Shopping history
- Pantry information

Wellness memory:
- Conversation-derived wellness observations
- Self-reported symptoms
- Longitudinal trends
- Emotional and social context
- Follow-up history

Finance memory:
- Authorized financial records
- Bill history
- Invoice analyses
- Disputes
- Financial approvals

Shared user preferences and household information may be accessed according to explicit permissions.

Sensitive agent-specific data must not be exposed to other agents by default.

## 5. Cross-Agent Collaboration

Although the agents are independent, they should be able to coordinate through a controlled event-driven system.

Examples:

**Wellness → Guardian**

The Wellness Agent receives a report of an urgent safety concern. It requests a Guardian escalation through a validated event.

**Care → Guardian**

The Care Agent discovers that an older adult needs physical help collecting medication. It asks Guardian to coordinate human assistance.

**Care → Finance**

The Care Agent prepares a grocery order. The Finance Agent may review a payment approval only if the user has enabled that workflow.

**Wellness → Care**

The Wellness Agent learns that the user has difficulty preparing meals. With permission, it requests meal or grocery assistance from Care.

Implement an AgentEventBus using Convex.

Events must include:
- Source agent
- Target agent
- Event type
- Authorized user
- Relevant permitted payload
- Timestamp
- Correlation ID
- Execution status

Do not transmit entire private conversation histories between agents.

## 6. Independent Voice Conversations

Each agent must have its own voice session and conversation history.

Use Cartesia for natural voice interaction.

When users open Guardian, they should interact directly with Guardian.

When users open Wellness, they should interact directly with Wellness.

Agent switching should be simple, but the system must preserve each agent's conversational context.

Voice sessions must support interruption and clear microphone controls where the underlying integration permits.

## 7. Independent Agent Execution

Agents must perform tasks beyond generating text.

Example:

User opens Care Agent and says:

"I need my usual groceries delivered tomorrow."

Care Agent:
1. Retrieves preferences.
2. Searches products.
3. Creates a shopping cart.
4. Requests approval.
5. Executes supported ordering actions after approval.
6. Tracks the order.
7. Updates the Care dashboard.

The Guardian, Wellness, and Finance agents should not need to execute this workflow.

Each agent must independently handle:
- Planning
- Tool execution
- Approvals
- Retries
- Completion tracking
- User feedback

## 8. Family Dashboard

The caregiver dashboard should aggregate permitted updates from all four agents.

Show separate sections for:
- Guardian alerts
- Care reminders and tasks
- Wellness summaries
- Finance approvals

Allow caregivers to filter activity by agent.

Caregiver access must respect the older adult's consent and configured permissions.

## 9. Frontend Navigation

Mobile bottom navigation:

- Home
- Agents
- Activity
- Family
- Profile

The Agents page displays all four AI agents.

Each agent has a dedicated route:

- /agents/guardian
- /agents/care
- /agents/wellness
- /agents/finance

Each route should have a distinct, polished interface while retaining Kinline's shared design system.

## 10. Technical Implementation

Suggested project structure:

src/
  agents/
    base/
      BaseAgent.ts
      AgentRuntime.ts
      ToolRegistry.ts
      AgentEventBus.ts
    guardian/
      GuardianAgent.ts
      guardianPrompt.ts
      guardianTools.ts
    care/
      CareAgent.ts
      carePrompt.ts
      careTools.ts
    wellness/
      WellnessAgent.ts
      wellnessPrompt.ts
      wellnessTools.ts
    finance/
      FinanceAgent.ts
      financePrompt.ts
      financeTools.ts
  components/
    agents/
    voice/
    dashboard/
    family/
  integrations/
  lib/
  app/

Use Convex as the primary backend and Auth0 for authentication.

Use Claude for agent reasoning, Cartesia for voice, and Moss for personal memory where the actual SDK supports the required capabilities.

Maintain distinct agent identities and permissions while sharing common infrastructure.

## 11. Acceptance Criteria

The application is complete only when:

1. All four agent pages are accessible on mobile.
2. Each agent has a distinct functional conversation.
3. Each agent has its own tools and persistent history.
4. At least one meaningful end-to-end workflow works for each agent.
5. Agent tasks persist and display real status.
6. Caregivers can see authorized updates.
7. Cross-agent events work with explicit permission checks.
8. Voice and text interfaces both function.
9. Sensitive actions require approval.
10. The PWA is installable and responsive.
11. Automated tests verify isolation and cross-agent permissions.
12. External integrations are honestly identified as live, sandbox, or unavailable.

Do not collapse the four agents into a single assistant.

Build four actual AI agents inside one coherent, production-minded Kinline application.