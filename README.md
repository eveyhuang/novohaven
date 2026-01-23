# NovoHaven - AI Workflow Orchestration Platform

A web-based platform for creating, customizing, and executing multi-step AI workflows for product research and listing creation.

## Features

- **Recipe Builder**: Create multi-step AI workflows with a visual editor
- **Multiple AI Providers**: Support for OpenAI, Anthropic (Claude), and Google Gemini
- **Variable System**: Use `{{variable_name}}` for user inputs, `{{step_N_output}}` for previous step results
- **Company Standards**: Define brand voice, platform requirements, and image style guidelines
- **Review Workflow**: Approve, reject, or edit AI outputs at each step
- **Pre-built Templates**: Start with ready-to-use recipe templates

## Tech Stack

- **Frontend**: React 18 + TypeScript + Tailwind CSS + React Router
- **Backend**: Node.js + Express + TypeScript
- **Database**: SQLite with better-sqlite3
- **AI Integration**: OpenAI, Anthropic, Google Gemini APIs

## Project Structure

```
novohaven-app/
├── client/                    # React frontend
│   ├── src/
│   │   ├── components/        # UI components
│   │   ├── services/          # API client
│   │   ├── context/           # React context (auth)
│   │   ├── types/             # TypeScript types
│   │   └── App.tsx
│   └── package.json
├── server/                    # Express backend
│   ├── src/
│   │   ├── routes/            # API endpoints
│   │   ├── services/          # Business logic
│   │   ├── models/            # Database
│   │   └── index.ts
│   └── package.json
├── .env.example
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd novohaven-app
```

2. Set up environment variables:
```bash
cp .env.example .env
# Edit .env and add your API keys
```

3. Install server dependencies:
```bash
cd server
npm install
```

4. Install client dependencies:
```bash
cd ../client
npm install
```

### Running the Application

1. Start the server (from the server directory):
```bash
npm run dev
```
The server will run on http://localhost:3001

2. Start the client (from the client directory):
```bash
npm start
```
The client will run on http://localhost:3000

### Using Mock AI Provider

If you don't have API keys set up, you can still test the platform using the "Mock (Testing)" provider. This simulates AI responses for development and testing purposes.

## API Endpoints

### Recipes
- `GET /api/recipes` - List all recipes
- `POST /api/recipes` - Create a recipe
- `GET /api/recipes/:id` - Get recipe details
- `PUT /api/recipes/:id` - Update a recipe
- `DELETE /api/recipes/:id` - Delete a recipe
- `POST /api/recipes/:id/clone` - Clone a recipe

### Executions
- `GET /api/executions` - List all executions
- `POST /api/executions` - Start a new execution
- `GET /api/executions/:id` - Get execution status
- `POST /api/executions/:id/steps/:stepId/approve` - Approve step
- `POST /api/executions/:id/steps/:stepId/reject` - Reject step
- `POST /api/executions/:id/steps/:stepId/retry` - Retry with modifications

### Company Standards
- `GET /api/standards` - List all standards
- `POST /api/standards` - Create a standard
- `PUT /api/standards/:id` - Update a standard
- `DELETE /api/standards/:id` - Delete a standard

### AI
- `GET /api/ai/models` - Get available AI models
- `GET /api/ai/providers` - Get provider status
- `POST /api/ai/test` - Test AI prompt

## Variable System

Use variables in your prompt templates:

### User Input Variables
```
{{product_name}}
{{target_audience}}
```

### Previous Step Output
```
{{step_1_output}}
{{step_2_output}}
```

### Company Standards
```
{{brand_voice}}
{{amazon_requirements}}
{{image_style_guidelines}}
```

## Pre-built Templates

1. **Product Research & Listing Generator** - Research products and create optimized e-commerce listings
2. **Content Repurposing Pipeline** - Transform content into multiple formats
3. **Product Image & Description Suite** - Generate descriptions and image prompts

## Authentication

The MVP uses mock authentication with a demo user. In production, replace with proper JWT authentication.

Default credentials:
- Email: demo@novohaven.com
- Password: (any value)

## License

MIT
