import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from '../context/AuthContext'
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../lib/apiClient'
import type { GeneratedEmailListOut, GeneratedEmailOut } from '../lib/generatedEmailTypes'
import {
  HISTORY_ROW_FADE_OUT_MS,
  logSuccessToastMessage,
  retractSuccessToastMessage,
} from '../lib/historyFeedback'
import type { OutcomeEventType, OutcomeOut } from '../lib/outcomeTypes'
import { HistoryPage } from './HistoryPage'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function seedAuth() {
  localStorage.setItem(ACCESS_TOKEN_KEY, 'access-token')
  localStorage.setItem(REFRESH_TOKEN_KEY, 'refresh-token')
}

const loggedEmail: GeneratedEmailListOut = {
  id: 101,
  subject: 'Interest in Backend Role',
  contact_name: 'Alex Recruiter',
  contact_title: 'Technical Recruiter',
  company_name: 'Acme',
  eval_score: 4.2,
  gate_passed: true,
  created_at: '2026-08-01T12:00:00Z',
}

const unloggedEmail: GeneratedEmailListOut = {
  id: 202,
  subject: 'Quick note about the TA role',
  contact_name: 'Sam Hiring',
  contact_title: 'Hiring Manager',
  company_name: 'Globex',
  eval_score: 3.8,
  gate_passed: false,
  created_at: '2026-08-02T15:30:00Z',
}

const fullLoggedEmail: GeneratedEmailOut = {
  id: 101,
  contact_id: 1,
  resume_id: 2,
  job_description_id: 3,
  subject: 'Interest in Backend Role',
  body: 'Hi Alex,\n\nI am interested in the backend role.\n\nBest regards,\nJordan',
  eval_score: 4.2,
  eval_breakdown: {
    gates: {
      no_unsupported_claims: true,
      correct_contact_name_used: true,
      no_unprompted_gap_admission: true,
    },
    dimensions: {
      role_company_specificity: 4,
      relevance_alignment: 4,
      tone_professionalism: 5,
      conciseness: 4,
      clear_cta: 4,
    },
  },
  match_data: {
    skill_matches: [],
    experience_alignment: [],
    unmatched_jd_requirements: [],
    notable_resume_strengths: [],
    overall_match_summary: 'Strong overlap on backend skills.',
  },
  gate_passed: true,
  created_at: '2026-08-01T12:00:00Z',
}

const sentOutcome: OutcomeOut = {
  id: 501,
  generated_email_id: 101,
  event_type: 'sent',
  occurred_at: '2026-08-01T13:00:00Z',
  voided: false,
}

const ALL_EVENT_TYPES: OutcomeEventType[] = [
  'sent',
  'replied',
  'interview',
  'no_response',
]

function mockInitialLists(
  emails: GeneratedEmailListOut[],
  outcomes: OutcomeOut[],
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/generated-emails')) {
      return jsonResponse(emails)
    }
    if (url.endsWith('/outcomes') || url.includes('/outcomes?')) {
      return jsonResponse(outcomes)
    }
    return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderHistory() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/history']}>
          <HistoryPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

function toastEl() {
  return document.querySelector('.history-toast')
}

describe('HistoryPage', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    seedAuth()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('defaults to Logged filter and hides unlogged emails', async () => {
    mockInitialLists([loggedEmail, unloggedEmail], [sentOutcome])
    renderHistory()

    expect(
      await screen.findByText('Interest in Backend Role'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Quick note about the TA role'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Logged' })).toBeChecked()
  })

  it('filter toggle shows all and unlogged emails', async () => {
    const user = userEvent.setup()
    mockInitialLists([loggedEmail, unloggedEmail], [sentOutcome])
    renderHistory()

    await screen.findByText('Interest in Backend Role')

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('Interest in Backend Role')).toBeInTheDocument()
    expect(
      screen.getByText('Quick note about the TA role'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Not yet logged' }))
    expect(
      screen.queryByText('Interest in Backend Role'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Quick note about the TA role'),
    ).toBeInTheDocument()
  })

  it('row expansion fetches full email and shows outcome timeline', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/generated-emails')) {
        return jsonResponse([loggedEmail, unloggedEmail])
      }
      if (url.endsWith('/outcomes')) {
        return jsonResponse([sentOutcome])
      }
      if (url.endsWith('/generated-emails/101') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(fullLoggedEmail)
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await screen.findByText('Interest in Backend Role')
    await user.click(screen.getByText('Interest in Backend Role'))

    expect(
      await screen.findByText(/I am interested in the backend role/),
    ).toBeInTheDocument()
    const timeline = screen.getByText('Outcome timeline').closest('div')
    expect(timeline).not.toBeNull()
    expect(
      within(timeline as HTMLElement).getByText('Sent'),
    ).toBeInTheDocument()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/generated-emails\/101$/),
        expect.anything(),
      )
    })
  })

  it('logging a new event type updates the timeline and logged badge', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([unloggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/202') && method === 'GET') {
        return jsonResponse({
          ...fullLoggedEmail,
          id: 202,
          subject: unloggedEmail.subject,
          body: 'Hi Sam,\n\nQuick note.\n\nBest regards,\nJordan',
        })
      }
      if (url.endsWith('/outcomes') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          generated_email_id: number
          event_type: OutcomeOut['event_type']
        }
        const created: OutcomeOut = {
          id: 777,
          generated_email_id: body.generated_email_id,
          event_type: body.event_type,
          occurred_at: '2026-08-06T10:00:00Z',
          voided: false,
        }
        outcomes = [...outcomes, created]
        return jsonResponse(created, 201)
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await screen.findByText('No emails with logged outcomes yet.')

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(
      await screen.findByText('Quick note about the TA role'),
    ).toBeInTheDocument()

    const row = screen
      .getByText('Quick note about the TA role')
      .closest('.history-email-row')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('Not logged')).toBeInTheDocument()

    await user.click(screen.getByText('Quick note about the TA role'))
    await screen.findByText(/Quick note\./)

    const form = screen.getByRole('form', { name: 'Log an outcome' })
    // Without a non-voided Sent, only Sent is enabled — log that first.
    const select = within(form).getByLabelText('Event type')
    expect(within(select).getByRole('option', { name: 'Sent' })).not.toBeDisabled()
    expect(
      within(select).getByRole('option', { name: 'Replied' }),
    ).toBeDisabled()
    await user.selectOptions(select, 'sent')
    await user.click(within(form).getByRole('button', { name: 'Log outcome' }))

    await waitFor(() => {
      const timeline = within(row as HTMLElement)
        .getByText('Outcome timeline')
        .closest('div')
      expect(timeline).not.toBeNull()
      expect(
        within(timeline as HTMLElement).getByText('Sent'),
      ).toBeInTheDocument()
    })
    expect(within(row as HTMLElement).getByText('Logged')).toBeInTheDocument()
    // All tab: in-place update only — no fade/remove.
    expect(row).not.toHaveClass('is-leaving')

    await user.click(screen.getByRole('radio', { name: 'Logged' }))
    await waitFor(() => {
      expect(
        document.querySelector('.history-logged-badge.history-logged-yes'),
      ).not.toBeNull()
    })
    expect(
      screen.getByText('Quick note about the TA role', {
        selector: '.history-email-subject',
      }),
    ).toBeInTheDocument()
  })

  it('retract removes timeline entry and drops row from default Logged filter when last', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = [sentOutcome]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([loggedEmail, unloggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/101') && method === 'GET') {
        return jsonResponse(fullLoggedEmail)
      }
      if (url.endsWith('/outcomes/501/retract') && method === 'POST') {
        outcomes = []
        return jsonResponse({ ...sentOutcome, voided: true })
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    expect(
      await screen.findByText('Interest in Backend Role'),
    ).toBeInTheDocument()

    await user.click(screen.getByText('Interest in Backend Role'))
    await screen.findByText(/I am interested in the backend role/)
    const timeline = screen.getByText('Outcome timeline').closest('div')
    expect(timeline).not.toBeNull()
    expect(
      within(timeline as HTMLElement).getByText('Sent'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retract' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    const row = screen
      .getByText('Interest in Backend Role', {
        selector: '.history-email-subject',
      })
      .closest('.history-email-row')
    await waitFor(() => {
      expect(row).toHaveClass('is-leaving')
    })

    await waitFor(
      () => {
        expect(
          screen.queryByText('Interest in Backend Role'),
        ).not.toBeInTheDocument()
      },
      { timeout: HISTORY_ROW_FADE_OUT_MS + 1000 },
    )
    expect(screen.getByRole('radio', { name: 'Logged' })).toBeChecked()
    expect(
      screen.getByText('No emails with logged outcomes yet.'),
    ).toBeInTheDocument()
  })

  it('expands only one row at a time (accordion)', async () => {
    const user = userEvent.setup()
    const secondLogged: GeneratedEmailListOut = {
      ...loggedEmail,
      id: 102,
      subject: 'Follow-up on platform role',
    }
    const secondOutcome: OutcomeOut = {
      ...sentOutcome,
      id: 502,
      generated_email_id: 102,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/generated-emails')) {
        return jsonResponse([loggedEmail, secondLogged])
      }
      if (url.endsWith('/outcomes')) {
        return jsonResponse([sentOutcome, secondOutcome])
      }
      if (url.endsWith('/generated-emails/101') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(fullLoggedEmail)
      }
      if (url.endsWith('/generated-emails/102') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({
          ...fullLoggedEmail,
          id: 102,
          subject: secondLogged.subject,
          body: 'Hi,\n\nFollowing up on the platform role.\n',
        })
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    const firstSubject = () =>
      screen.getByText('Interest in Backend Role', {
        selector: '.history-email-subject',
      })
    const secondSubject = () =>
      screen.getByText('Follow-up on platform role', {
        selector: '.history-email-subject',
      })

    await waitFor(() => {
      expect(firstSubject()).toBeInTheDocument()
    })
    await user.click(firstSubject())
    expect(
      await screen.findByText(/I am interested in the backend role/),
    ).toBeInTheDocument()

    await user.click(secondSubject())
    expect(
      await screen.findByText(/Following up on the platform role/),
    ).toBeInTheDocument()

    expect(firstSubject().closest('button')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(secondSubject().closest('button')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await waitFor(() => {
      expect(
        firstSubject().closest('.history-email-row')?.querySelector(
          '.history-email-expand',
        ),
      ).not.toHaveClass('is-expanded')
      expect(
        secondSubject().closest('.history-email-row')?.querySelector(
          '.history-email-expand',
        ),
      ).toHaveClass('is-expanded')
    })
  })

  it('disables non-Sent options until Sent exists, then disables Sent', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([unloggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/202') && method === 'GET') {
        return jsonResponse({
          ...fullLoggedEmail,
          id: 202,
          subject: unloggedEmail.subject,
          body: 'Hi Sam,\n\nQuick note.\n\nBest regards,\nJordan',
        })
      }
      if (url.endsWith('/outcomes') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          generated_email_id: number
          event_type: OutcomeOut['event_type']
        }
        const created: OutcomeOut = {
          id: 778,
          generated_email_id: body.generated_email_id,
          event_type: body.event_type,
          occurred_at: '2026-08-06T11:00:00Z',
          voided: false,
        }
        outcomes = [...outcomes, created]
        return jsonResponse(created, 201)
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await user.click(await screen.findByRole('radio', { name: 'All' }))
    await user.click(
      await screen.findByText('Quick note about the TA role'),
    )
    await screen.findByText(/Quick note\./)

    const form = screen.getByRole('form', { name: 'Log an outcome' })
    const select = within(form).getByLabelText('Event type')
    expect(within(select).getByRole('option', { name: 'Sent' })).not.toBeDisabled()
    expect(
      within(select).getByRole('option', { name: 'No response' }),
    ).toBeDisabled()
    expect(
      within(select).getByRole('option', { name: 'Interview' }),
    ).toBeDisabled()

    await user.click(within(form).getByRole('button', { name: 'Log outcome' }))

    await waitFor(() => {
      expect(
        within(select).getByRole('option', { name: 'Sent' }),
      ).toBeDisabled()
    })
    expect(
      within(select).getByRole('option', { name: 'Replied' }),
    ).not.toBeDisabled()
  })

  it('shows cascade confirm copy when retracting Sent with other outcomes', async () => {
    const user = userEvent.setup()
    const repliedOutcome: OutcomeOut = {
      id: 502,
      generated_email_id: 101,
      event_type: 'replied',
      occurred_at: '2026-08-02T14:00:00Z',
      voided: false,
    }
    let outcomes: OutcomeOut[] = [sentOutcome, repliedOutcome]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([loggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/101') && method === 'GET') {
        return jsonResponse(fullLoggedEmail)
      }
      if (url.endsWith('/outcomes/501/retract') && method === 'POST') {
        outcomes = []
        return jsonResponse({ ...sentOutcome, voided: true })
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await user.click(await screen.findByText('Interest in Backend Role'))
    await screen.findByText(/I am interested in the backend role/)

    const timeline = screen.getByText('Outcome timeline').closest('div')
    expect(timeline).not.toBeNull()
    const sentItem = within(timeline as HTMLElement)
      .getByText('Sent')
      .closest('li')
    expect(sentItem).not.toBeNull()

    await user.click(
      within(sentItem as HTMLElement).getByRole('button', { name: 'Retract' }),
    )
    expect(
      screen.getByText(/Retracting 'Sent' will also retract all other logged outcomes/),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(
      () => {
        expect(
          screen.getByText('No emails with logged outcomes yet.'),
        ).toBeInTheDocument()
      },
      { timeout: HISTORY_ROW_FADE_OUT_MS + 1000 },
    )
  })

  it('collapses the expanded row when the filter tab changes', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/generated-emails')) {
        return jsonResponse([loggedEmail, unloggedEmail])
      }
      if (url.endsWith('/outcomes')) {
        return jsonResponse([sentOutcome])
      }
      if (url.endsWith('/generated-emails/101') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(fullLoggedEmail)
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    const subject = () =>
      screen.getByText('Interest in Backend Role', {
        selector: '.history-email-subject',
      })

    await waitFor(() => {
      expect(subject()).toBeInTheDocument()
    })
    await user.click(subject())
    expect(
      await screen.findByText(/I am interested in the backend role/),
    ).toBeInTheDocument()
    expect(subject().closest('button')).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      expect(
        subject().closest('.history-email-row')?.querySelector(
          '.history-email-expand',
        ),
      ).toHaveClass('is-expanded')
    })

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(subject()).toBeInTheDocument()
    expect(
      screen.getByText('Quick note about the TA role', {
        selector: '.history-email-subject',
      }),
    ).toBeInTheDocument()
    expect(subject().closest('button')).toHaveAttribute('aria-expanded', 'false')
    expect(
      subject().closest('.history-email-row')?.querySelector(
        '.history-email-expand',
      ),
    ).not.toHaveClass('is-expanded')
  })

  it('shows event-type-specific toast text for each log and retract', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = []
    let nextId = 800
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([unloggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/202') && method === 'GET') {
        return jsonResponse({
          ...fullLoggedEmail,
          id: 202,
          subject: unloggedEmail.subject,
          body: 'Hi Sam,\n\nQuick note.\n\nBest regards,\nJordan',
        })
      }
      if (url.endsWith('/outcomes') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          generated_email_id: number
          event_type: OutcomeEventType
        }
        const created: OutcomeOut = {
          id: nextId++,
          generated_email_id: body.generated_email_id,
          event_type: body.event_type,
          occurred_at: '2026-08-08T10:00:00Z',
          voided: false,
        }
        outcomes = [...outcomes, created]
        return jsonResponse(created, 201)
      }
      const retractMatch = url.match(/\/outcomes\/(\d+)\/retract$/)
      if (retractMatch && method === 'POST') {
        const outcomeId = Number(retractMatch[1])
        const target = outcomes.find((o) => o.id === outcomeId)
        if (!target) {
          return jsonResponse({ user_message: 'Missing', error_code: 'Test' }, 404)
        }
        if (target.event_type === 'sent') {
          outcomes = []
        } else {
          outcomes = outcomes.filter((o) => o.id !== outcomeId)
        }
        return jsonResponse({ ...target, voided: true })
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await user.click(await screen.findByRole('radio', { name: 'All' }))
    await user.click(
      await screen.findByText('Quick note about the TA role'),
    )
    await screen.findByText(/Quick note\./)

    const form = screen.getByRole('form', { name: 'Log an outcome' })
    const select = within(form).getByLabelText('Event type')

    for (const eventType of ALL_EVENT_TYPES) {
      await user.selectOptions(select, eventType)
      await user.click(within(form).getByRole('button', { name: 'Log outcome' }))
      await waitFor(() => {
        expect(toastEl()?.textContent).toBe(logSuccessToastMessage(eventType))
      })
      expect(document.querySelectorAll('.history-toast')).toHaveLength(1)
    }

    // Retract non-Sent types first (leaves Sent), then Sent last.
    const retractOrder: OutcomeEventType[] = [
      'replied',
      'interview',
      'no_response',
      'sent',
    ]
    for (const eventType of retractOrder) {
      const timeline = screen.getByText('Outcome timeline').closest('div')
      expect(timeline).not.toBeNull()
      const label =
        eventType === 'no_response'
          ? 'No response'
          : eventType === 'sent'
            ? 'Sent'
            : eventType === 'replied'
              ? 'Replied'
              : 'Interview'
      const item = within(timeline as HTMLElement).getByText(label).closest('li')
      expect(item).not.toBeNull()
      await user.click(
        within(item as HTMLElement).getByRole('button', { name: 'Retract' }),
      )
      await user.click(screen.getByRole('button', { name: 'Confirm' }))
      await waitFor(() => {
        expect(toastEl()?.textContent).toBe(
          retractSuccessToastMessage(eventType),
        )
      })
      expect(document.querySelectorAll('.history-toast')).toHaveLength(1)
    }
  })

  it('replaces an in-flight toast instead of stacking', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = [sentOutcome]
    let nextId = 900
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([loggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/101') && method === 'GET') {
        return jsonResponse(fullLoggedEmail)
      }
      if (url.endsWith('/outcomes') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          generated_email_id: number
          event_type: OutcomeEventType
        }
        const created: OutcomeOut = {
          id: nextId++,
          generated_email_id: body.generated_email_id,
          event_type: body.event_type,
          occurred_at: '2026-08-08T12:00:00Z',
          voided: false,
        }
        outcomes = [...outcomes, created]
        return jsonResponse(created, 201)
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await user.click(await screen.findByText('Interest in Backend Role'))
    await screen.findByText(/I am interested in the backend role/)

    const form = screen.getByRole('form', { name: 'Log an outcome' })
    const select = within(form).getByLabelText('Event type')
    await user.selectOptions(select, 'replied')
    await user.click(within(form).getByRole('button', { name: 'Log outcome' }))
    await waitFor(() => {
      expect(toastEl()?.textContent).toBe('Marked as Replied')
    })

    await user.selectOptions(select, 'interview')
    await user.click(within(form).getByRole('button', { name: 'Log outcome' }))
    await waitFor(() => {
      expect(toastEl()?.textContent).toBe('Marked as Interview')
    })
    expect(document.querySelectorAll('.history-toast')).toHaveLength(1)
  })

  it('fades and removes a row from Not yet logged on its first log', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([unloggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/202') && method === 'GET') {
        return jsonResponse({
          ...fullLoggedEmail,
          id: 202,
          subject: unloggedEmail.subject,
          body: 'Hi Sam,\n\nQuick note.\n\nBest regards,\nJordan',
        })
      }
      if (url.endsWith('/outcomes') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          generated_email_id: number
          event_type: OutcomeEventType
        }
        const created: OutcomeOut = {
          id: 901,
          generated_email_id: body.generated_email_id,
          event_type: body.event_type,
          occurred_at: '2026-08-08T13:00:00Z',
          voided: false,
        }
        outcomes = [created]
        return jsonResponse(created, 201)
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await user.click(await screen.findByRole('radio', { name: 'Not yet logged' }))
    await user.click(
      await screen.findByText('Quick note about the TA role'),
    )
    await screen.findByText(/Quick note\./)

    const row = screen
      .getByText('Quick note about the TA role', {
        selector: '.history-email-subject',
      })
      .closest('.history-email-row')
    expect(row).not.toBeNull()

    const form = screen.getByRole('form', { name: 'Log an outcome' })
    await user.click(within(form).getByRole('button', { name: 'Log outcome' }))

    await waitFor(() => {
      expect(toastEl()?.textContent).toBe('Marked as Sent')
      expect(row).toHaveClass('is-leaving')
    })

    await waitFor(
      () => {
        expect(
          screen.queryByText('Quick note about the TA role'),
        ).not.toBeInTheDocument()
      },
      { timeout: HISTORY_ROW_FADE_OUT_MS + 1000 },
    )
    expect(
      screen.getByText('Every email already has at least one outcome.'),
    ).toBeInTheDocument()
  })

  it('fades and removes a row from Logged when its last outcome is retracted', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = [sentOutcome]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([loggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/101') && method === 'GET') {
        return jsonResponse(fullLoggedEmail)
      }
      if (url.endsWith('/outcomes/501/retract') && method === 'POST') {
        outcomes = []
        return jsonResponse({ ...sentOutcome, voided: true })
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await user.click(await screen.findByText('Interest in Backend Role'))
    await screen.findByText(/I am interested in the backend role/)

    const row = screen
      .getByText('Interest in Backend Role', {
        selector: '.history-email-subject',
      })
      .closest('.history-email-row')

    await user.click(screen.getByRole('button', { name: 'Retract' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      expect(toastEl()?.textContent).toBe('Retracted: Sent')
      expect(row).toHaveClass('is-leaving')
    })

    await waitFor(
      () => {
        expect(
          screen.queryByText('Interest in Backend Role'),
        ).not.toBeInTheDocument()
      },
      { timeout: HISTORY_ROW_FADE_OUT_MS + 1000 },
    )
  })

  it('does not fade or remove on All for log or retract — updates in place', async () => {
    const user = userEvent.setup()
    let outcomes: OutcomeOut[] = []
    let createdId = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/generated-emails') && method === 'GET') {
        return jsonResponse([unloggedEmail])
      }
      if (url.endsWith('/outcomes') && method === 'GET') {
        return jsonResponse(outcomes)
      }
      if (url.endsWith('/generated-emails/202') && method === 'GET') {
        return jsonResponse({
          ...fullLoggedEmail,
          id: 202,
          subject: unloggedEmail.subject,
          body: 'Hi Sam,\n\nQuick note.\n\nBest regards,\nJordan',
        })
      }
      if (url.endsWith('/outcomes') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          generated_email_id: number
          event_type: OutcomeEventType
        }
        const created: OutcomeOut = {
          id: 950,
          generated_email_id: body.generated_email_id,
          event_type: body.event_type,
          occurred_at: '2026-08-08T14:00:00Z',
          voided: false,
        }
        createdId = created.id
        outcomes = [created]
        return jsonResponse(created, 201)
      }
      if (url.endsWith(`/outcomes/${createdId}/retract`) && method === 'POST') {
        const voided = { ...outcomes[0], voided: true }
        outcomes = []
        return jsonResponse(voided)
      }
      return jsonResponse({ user_message: 'Unexpected', error_code: 'Test' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderHistory()

    await user.click(await screen.findByRole('radio', { name: 'All' }))
    await user.click(
      await screen.findByText('Quick note about the TA role'),
    )
    await screen.findByText(/Quick note\./)

    const row = () =>
      screen
        .getByText('Quick note about the TA role', {
          selector: '.history-email-subject',
        })
        .closest('.history-email-row') as HTMLElement

    const form = screen.getByRole('form', { name: 'Log an outcome' })
    await user.click(within(form).getByRole('button', { name: 'Log outcome' }))

    await waitFor(() => {
      expect(toastEl()?.textContent).toBe('Marked as Sent')
      expect(within(row()).getByText('Logged')).toBeInTheDocument()
    })
    expect(row()).not.toHaveClass('is-leaving')
    expect(
      screen.getByText('Quick note about the TA role', {
        selector: '.history-email-subject',
      }),
    ).toBeInTheDocument()

    await user.click(within(row()).getByRole('button', { name: 'Retract' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      expect(toastEl()?.textContent).toBe('Retracted: Sent')
      expect(within(row()).getByText('Not logged')).toBeInTheDocument()
    })
    expect(row()).not.toHaveClass('is-leaving')
    expect(
      screen.getByText('Quick note about the TA role', {
        selector: '.history-email-subject',
      }),
    ).toBeInTheDocument()
  })
})
