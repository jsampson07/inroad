import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { GeneratedEmailStep } from '../components/GeneratedEmailStep'
import { JobDescriptionStep } from '../components/JobDescriptionStep'
import { ResumeStep } from '../components/ResumeStep'
import { AppHeader } from '../components/AppHeader'
import { useAuth } from '../context/AuthContext'
import { useResumeForGeneration } from '../hooks/useResumeForGeneration'
import { ApiError } from '../lib/apiClient'
import { discoverContact, searchCompanies } from '../lib/discoveryApi'
import {
  clearDiscoveryFlow,
  readDiscoveryFlow,
  writeCompanyLock,
  writeDiscoveryResult,
  writeGeneratedEmailResult,
  writeJobDescriptionResult,
  writeResumeResult,
  writeSentOutcomeLogged,
} from '../lib/discoverySession'
import type {
  CompanySearchCandidate,
  ConfidenceBreakdown,
  ContactDiscoveryResponse,
  LockedCompany,
} from '../lib/discoveryTypes'
import type { JobDescriptionOut } from '../lib/documentTypes'
import type { GeneratedEmailOut } from '../lib/generatedEmailTypes'

type Frame = 1 | 2 | 3 | 4 | 5 | 6

/**
 * Map persisted + in-memory flow flags to the single visible frame.
 * pastDiscovery / pastResume / pastJd are explicit continues (not inferred
 * from ids) so successful extract/generate still shows a confirmation before
 * advancing — except rehydrate skips ahead when later results already exist.
 */
function frameFromState(args: {
  company: LockedCompany | null
  discoveryResult: ContactDiscoveryResponse | null
  resumeReady: boolean
  jdReady: boolean
  pastDiscovery: boolean
  pastResume: boolean
  pastJd: boolean
}): Frame {
  const {
    company,
    discoveryResult,
    resumeReady,
    jdReady,
    pastDiscovery,
    pastResume,
    pastJd,
  } = args
  if (!company) return 1
  if (!discoveryResult) return 2
  if (!pastDiscovery) return 3
  if (!resumeReady || !pastResume) return 4
  if (!jdReady || !pastJd) return 5
  return 6
}

function formatBreakdownValue(
  value: ConfidenceBreakdown[keyof ConfidenceBreakdown],
): string {
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }
  return String(value)
}

const BREAKDOWN_LABELS: Record<keyof ConfidenceBreakdown, string> = {
  verification_tier_score: 'Verification tier score',
  cross_provider_corroboration: 'Cross-provider corroboration',
  employment_currency_signal: 'Employment currency signal',
  domain_check_passed: 'Domain check passed',
  name_collision_detected: 'Name collision detected',
}

/**
 * Persistent `/` home: company → role → discovery → resume → JD → email.
 * Exactly one frame at a time; frame is flow state, not a route.
 */
export function HomePage() {
  const { logout } = useAuth()

  // Initialize from sessionStorage once so remount lands on the correct frame
  // without flashing FRAME 1 (lazy useState initializer, not a post-paint effect).
  const [initial] = useState(() => readDiscoveryFlow())
  const [company, setCompany] = useState<LockedCompany | null>(initial.company)
  const [discoveryResult, setDiscoveryResult] =
    useState<ContactDiscoveryResponse | null>(initial.discoveryResult)
  const [jobDescription, setJobDescription] =
    useState<JobDescriptionOut | null>(initial.jobDescription)
  const [generatedEmail, setGeneratedEmail] =
    useState<GeneratedEmailOut | null>(initial.generatedEmail)

  // Skip FRAME 3 on rehydrate when a resume/JD/email was already saved this tab.
  const [pastDiscovery, setPastDiscovery] = useState(
    () =>
      initial.resume != null ||
      initial.jobDescription != null ||
      initial.generatedEmail != null,
  )
  // Skip resume confirmation on rehydrate only when JD/email already exists.
  const [pastResume, setPastResume] = useState(
    () => initial.jobDescription != null || initial.generatedEmail != null,
  )
  // Skip JD confirmation on rehydrate only when a generated email already exists.
  const [pastJd, setPastJd] = useState(() => initial.generatedEmail != null)

  const [companyQuery, setCompanyQuery] = useState('')
  const [candidates, setCandidates] = useState<CompanySearchCandidate[] | null>(
    null,
  )
  const [showManualFallback, setShowManualFallback] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualDomain, setManualDomain] = useState('')
  const [roleTitle, setRoleTitle] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)

  const resumeForGeneration = useResumeForGeneration({
    initialResume: initial.resume,
    onReady: (extracted) => {
      if (!company || !discoveryResult) return
      writeResumeResult(company, discoveryResult, extracted)
    },
  })

  const frame = frameFromState({
    company,
    discoveryResult,
    resumeReady: resumeForGeneration.resume?.extracted_data != null,
    jdReady: jobDescription?.extracted_data != null,
    pastDiscovery,
    pastResume,
    pastJd,
  })

  const searchMutation = useMutation({
    mutationFn: (query: string) => searchCompanies(query),
    onSuccess: (data) => {
      setSearchError(null)
      if (data.candidates.length === 0) {
        // Zero candidates → same manual-domain fallback as a failed search (§7).
        setCandidates(null)
        setShowManualFallback(true)
        setManualName(companyQuery.trim())
        return
      }
      setCandidates(data.candidates)
      setShowManualFallback(false)
    },
    onError: (err) => {
      // Search failure → same user-facing manual fallback as zero candidates.
      // Internal detail differs; UI treatment does not (§7 / §6).
      setCandidates(null)
      setShowManualFallback(true)
      setManualName(companyQuery.trim())
      if (err instanceof ApiError) {
        setSearchError(err.user_message)
      } else {
        setSearchError('Something went wrong. Please try again.')
      }
    },
  })

  const discoverMutation = useMutation({
    mutationFn: ({
      domain,
      role_title,
    }: {
      domain: string
      role_title: string
    }) => discoverContact(domain, role_title),
    onSuccess: (data, variables) => {
      setDiscoverError(null)
      if (!company || company.domain !== variables.domain) return
      setDiscoveryResult(data)
      setPastDiscovery(false)
      setPastResume(false)
      setPastJd(false)
      setJobDescription(null)
      setGeneratedEmail(null)
      resumeForGeneration.reset()
      writeDiscoveryResult(company, data)
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setDiscoverError(err.user_message)
      } else {
        setDiscoverError('Something went wrong. Please try again.')
      }
    },
  })

  function lockCompany(next: LockedCompany) {
    setCompany(next)
    setDiscoveryResult(null)
    setJobDescription(null)
    setGeneratedEmail(null)
    setPastDiscovery(false)
    setPastResume(false)
    setPastJd(false)
    setCandidates(null)
    setShowManualFallback(false)
    setSearchError(null)
    setDiscoverError(null)
    setRoleTitle('')
    resumeForGeneration.reset()
    writeCompanyLock(next)
  }

  function startNewSearch() {
    setCompany(null)
    setDiscoveryResult(null)
    setJobDescription(null)
    setGeneratedEmail(null)
    setPastDiscovery(false)
    setPastResume(false)
    setPastJd(false)
    setCompanyQuery('')
    setCandidates(null)
    setShowManualFallback(false)
    setManualName('')
    setManualDomain('')
    setRoleTitle('')
    setSearchError(null)
    setDiscoverError(null)
    searchMutation.reset()
    discoverMutation.reset()
    resumeForGeneration.reset()
    clearDiscoveryFlow()
  }

  function handleCompanySearch(event: FormEvent) {
    event.preventDefault()
    const query = companyQuery.trim()
    if (!query) return
    setSearchError(null)
    setCandidates(null)
    setShowManualFallback(false)
    searchMutation.mutate(query)
  }

  function openManualFallback() {
    // Same destination frame as zero-candidates / Clearbit-failure auto-routes (§7).
    setCandidates(null)
    setShowManualFallback(true)
    setManualName(companyQuery.trim())
    setSearchError(null)
  }

  function handleManualConfirm(event: FormEvent) {
    event.preventDefault()
    const name = manualName.trim()
    const domain = manualDomain.trim().toLowerCase()
    if (!name || !domain) return
    lockCompany({ name, domain })
  }

  function handleDiscover(event: FormEvent) {
    event.preventDefault()
    if (!company) return
    const role_title = roleTitle.trim()
    if (!role_title) return
    setDiscoverError(null)
    discoverMutation.mutate({ domain: company.domain, role_title })
  }

  function handleContinueFromDiscovery() {
    // company_id for the JD step comes from the discovered contact — LockedCompany
    // only has name/domain. Without a contact we cannot create a JD frontend-only.
    if (!discoveryResult?.contact) return
    setPastDiscovery(true)
  }

  function handleContinueFromResume() {
    if (!resumeForGeneration.resume?.extracted_data) return
    setPastResume(true)
  }

  function handleContinueFromJd() {
    if (!jobDescription?.extracted_data) return
    setPastJd(true)
  }

  function handleJobDescriptionReady(jd: JobDescriptionOut) {
    if (!company || !discoveryResult || !resumeForGeneration.resume) return
    setJobDescription(jd)
    setGeneratedEmail(null)
    setPastJd(false)
    writeJobDescriptionResult(
      company,
      discoveryResult,
      resumeForGeneration.resume,
      jd,
    )
  }

  function handleGeneratedEmailReady(email: GeneratedEmailOut) {
    if (
      !company ||
      !discoveryResult ||
      !resumeForGeneration.resume ||
      !jobDescription
    ) {
      return
    }
    setGeneratedEmail(email)
    writeGeneratedEmailResult(
      company,
      discoveryResult,
      resumeForGeneration.resume,
      jobDescription,
      email,
    )
  }

  function handleSentOutcomeLogged() {
    writeSentOutcomeLogged()
  }

  const companyIdForJd = discoveryResult?.contact?.company_id ?? null
  const contactId = discoveryResult?.contact?.id ?? null
  const resumeId = resumeForGeneration.resumeId

  return (
    <main className="home-page discovery-page">
      <AppHeader
        actions={
          <>
            <button type="button" onClick={startNewSearch}>
              Start new search
            </button>
            <button type="button" onClick={() => void logout()}>
              Log out
            </button>
          </>
        }
      />

      {frame === 1 ? (
        <section aria-label="Company search">
          <p className="discovery-lead">
            Search for the company you&apos;re applying to, then pick the exact
            match. Nothing is selected automatically.
          </p>
          <form className="auth-form" onSubmit={handleCompanySearch}>
            <label>
              Company name
              <input
                type="text"
                name="companyQuery"
                value={companyQuery}
                onChange={(e) => setCompanyQuery(e.target.value)}
                autoComplete="organization"
                required
              />
            </label>
            <button type="submit" disabled={searchMutation.isPending}>
              {searchMutation.isPending ? 'Searching…' : 'Search'}
            </button>
          </form>

          {candidates && candidates.length > 0 ? (
            <div className="candidate-list">
              <p className="discovery-subhead">Select a company</p>
              <ul className="candidate-options">
                {candidates.map((candidate) => (
                  <li key={`${candidate.name}-${candidate.domain}`}>
                    <button
                      type="button"
                      className="candidate-option"
                      onClick={() =>
                        lockCompany({
                          name: candidate.name,
                          domain: candidate.domain,
                        })
                      }
                    >
                      <span className="candidate-name">{candidate.name}</span>
                      <span className="candidate-domain">
                        {candidate.domain}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="manual-escape">
                <button
                  type="button"
                  className="text-link"
                  onClick={openManualFallback}
                >
                  Can&apos;t find what you&apos;re looking for?
                </button>
              </p>
            </div>
          ) : null}

          {showManualFallback ? (
            <div className="manual-fallback">
              <p className="discovery-subhead">
                Haven&apos;t found what you&apos;re looking for?
              </p>
              <p className="discovery-muted">
                Enter the company domain directly to continue.
              </p>
              {searchError ? (
                <p className="discovery-muted" role="status">
                  {searchError}
                </p>
              ) : null}
              <form className="auth-form" onSubmit={handleManualConfirm}>
                <label>
                  Company name
                  <input
                    type="text"
                    name="manualName"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Company domain
                  <input
                    type="text"
                    name="manualDomain"
                    value={manualDomain}
                    onChange={(e) => setManualDomain(e.target.value)}
                    placeholder="example.com"
                    required
                  />
                </label>
                <button type="submit">Use this company</button>
              </form>
            </div>
          ) : null}
        </section>
      ) : null}

      {frame === 2 && company ? (
        <section aria-label="Discover contacts">
          <p className="discovery-confirm" role="status">
            Searching contacts at {company.name} ({company.domain})
          </p>
          <form className="auth-form" onSubmit={handleDiscover}>
            <label>
              Role title
              <input
                type="text"
                name="roleTitle"
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                placeholder="e.g. Software Engineer"
                required
              />
            </label>
            {/* role_title is unused by server-side tiering today but still
                required on ContactDiscoveryRequest — collect it here. */}
            <button type="submit" disabled={discoverMutation.isPending}>
              {discoverMutation.isPending
                ? 'Finding contact…'
                : 'Find contact'}
            </button>
          </form>
          {discoverError ? (
            <p className="auth-error" role="alert">
              {discoverError}
            </p>
          ) : null}
        </section>
      ) : null}

      {frame === 3 && company && discoveryResult ? (
        <section aria-label="Discovery result">
          <p className="discovery-confirm">
            Results for {company.name} ({company.domain})
          </p>

          {discoveryResult.contact ? (
            <div className="discovery-found">
              <dl className="contact-summary">
                <div>
                  <dt>Name</dt>
                  <dd>{discoveryResult.contact.name ?? '—'}</dd>
                </div>
                <div>
                  <dt>Title</dt>
                  <dd>{discoveryResult.contact.title ?? '—'}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{discoveryResult.contact.email ?? '—'}</dd>
                </div>
                <div>
                  <dt>Best verification tier</dt>
                  <dd>{discoveryResult.contact.best_verification_tier}</dd>
                </div>
                <div>
                  <dt>Confidence score</dt>
                  <dd>{discoveryResult.contact.confidence_score}</dd>
                </div>
                {discoveryResult.tier_used ? (
                  <div>
                    <dt>Tier used</dt>
                    <dd>{discoveryResult.tier_used}</dd>
                  </div>
                ) : null}
              </dl>

              {discoveryResult.fallback_reason ? (
                <p className="fallback-reason" role="status">
                  {discoveryResult.fallback_reason}
                </p>
              ) : null}

              <details className="confidence-breakdown">
                <summary>Confidence breakdown</summary>
                <dl>
                  {(
                    Object.keys(
                      BREAKDOWN_LABELS,
                    ) as (keyof ConfidenceBreakdown)[]
                  ).map((key) => (
                    <div key={key}>
                      <dt>{BREAKDOWN_LABELS[key]}</dt>
                      <dd>
                        {formatBreakdownValue(
                          discoveryResult.contact!.confidence_breakdown[key],
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>

              <button type="button" onClick={handleContinueFromDiscovery}>
                Continue to resume
              </button>
            </div>
          ) : (
            <div className="discovery-not-found">
              <p>
                No contact could be found for this company right now. All
                search tiers were tried without a usable result.
              </p>
              {discoveryResult.fallback_reason ? (
                <p className="fallback-reason" role="status">
                  {discoveryResult.fallback_reason}
                </p>
              ) : null}
              <p className="discovery-muted">
                A contact is required before resume and job-description steps
                (job descriptions need the resolved company id from the
                contact). Start a new search to try another company.
              </p>
            </div>
          )}
        </section>
      ) : null}

      {frame === 4 ? (
        <ResumeStep
          resumeForGeneration={resumeForGeneration}
          onContinue={handleContinueFromResume}
        />
      ) : null}

      {frame === 5 && company && companyIdForJd != null ? (
        <JobDescriptionStep
          companyId={companyIdForJd}
          companyName={company.name}
          initialJobDescription={jobDescription}
          onReady={handleJobDescriptionReady}
          onContinue={handleContinueFromJd}
        />
      ) : null}

      {frame === 6 &&
      contactId != null &&
      resumeId != null &&
      jobDescription != null ? (
        <GeneratedEmailStep
          contactId={contactId}
          resumeId={resumeId}
          jobDescriptionId={jobDescription.id}
          initialGeneratedEmail={generatedEmail}
          initialSentOutcomeLogged={initial.sentOutcomeLogged}
          onReady={handleGeneratedEmailReady}
          onSentLogged={handleSentOutcomeLogged}
        />
      ) : null}
    </main>
  )
}
