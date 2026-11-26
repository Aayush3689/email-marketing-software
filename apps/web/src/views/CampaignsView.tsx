import { useQuery } from '@tanstack/react-query';
import { Card } from '@mail/ui';
import {
  Activity,
  Ban,
  BarChart3,
  FileCode2,
  FileInput,
  Filter,
  Globe,
  ListOrdered,
  Mail,
  Send,
  SlidersHorizontal,
  Tag,
  Upload,
  Users,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { BroadcastsSection } from '../components/marketing/BroadcastsSection.js';
import {
  ImportExportWizardSection,
  SuppressionsSection,
} from '../components/marketing/ImportExportAndSuppressions.js';
import { SegmentsBuilderSection } from '../components/marketing/SegmentsBuilderSection.js';
import {
  AutomationsSection,
  GrowthSection,
  SequencesSection,
} from '../components/marketing/SequencesAutomationsGrowthSections.js';
import { SubscribersSection } from '../components/marketing/SubscribersSection.js';
import {
  CustomFieldsSection,
  TagsSection,
} from '../components/marketing/TagsAndFieldsSection.js';
import { TemplatesStudioSection } from '../components/marketing/TemplatesStudioSection.js';

type TopSection = 'audience' | 'marketing' | 'automations' | 'growth';
type AudienceTab = 'subscribers' | 'tags' | 'segments' | 'custom-fields' | 'import-export' | 'suppressions';
type MarketingTab = 'broadcasts' | 'sequences' | 'templates' | 'analytics';
type AutomationTab = 'builder' | 'activity';
type GrowthTab = 'forms' | 'landing-pages';

export function CampaignsView() {
  const [section, setSection] = useState<TopSection>(() => {
    try {
      const m = sessionStorage.getItem('fastconnect_broadcast_composer_mode');
      if (m === 'new' || m === 'edit') return 'marketing';
    } catch {
      // ignore
    }
    return 'marketing';
  });
  const [audienceTab, setAudienceTab] = useState<AudienceTab>('subscribers');
  const [marketingTab, setMarketingTab] = useState<MarketingTab>('broadcasts');
  const [automationTab, setAutomationTab] = useState<AutomationTab>('builder');
  const [growthTab, setGrowthTab] = useState<GrowthTab>('forms');
  const [tagFilterShortcut, setTagFilterShortcut] = useState<string | undefined>(undefined);

  const subscribersSummary = useQuery({
    queryKey: ['subscribers', 'summary-count'],
    queryFn: () => api.listSubscribers({ pageSize: 1 }),
  });
  const campaignsSummary = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.listCampaigns(),
  });
  const sequencesSummary = useQuery({
    queryKey: ['sequences'],
    queryFn: () => api.listSequences(),
  });
  const automationsSummary = useQuery({
    queryKey: ['automations'],
    queryFn: () => api.listAutomations(),
  });

  const handleViewSubscribersWithTag = (tagName: string) => {
    setTagFilterShortcut(tagName);
    setSection('audience');
    setAudienceTab('subscribers');
  };

  const handleOpenImportWizard = () => {
    setSection('audience');
    setAudienceTab('import-export');
  };

  const handleOpenTagManager = () => {
    setSection('audience');
    setAudienceTab('tags');
  };

  // Top-level domain navigation tabs (underlined navigation bar — visually distinct from action buttons)
  const topNavTabClass = (active: boolean) =>
    `inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer ${
      active
        ? 'border-[var(--color-brand)] text-[var(--color-text)]'
        : 'border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'
    }`;

  // Secondary sub-navigation segmented items
  const subNavTabClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
      active
        ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm border border-[var(--color-border)]'
        : 'border border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-text)]">
            Audience &amp; Email Marketing
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            One unified subscriber audience organized by central tags, custom fields, and dynamic segments — powering broadcasts, drip sequences, visual automations, and growth forms.
          </p>
        </div>
      </div>

      {/* Live Quick Metrics Strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          onClick={() => {
            setSection('audience');
            setAudienceTab('subscribers');
          }}
          className="cursor-pointer p-4 hover:border-[var(--color-brand)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Subscribers</span>
            <Users className="h-4 w-4 text-[var(--color-text-muted)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold text-[var(--color-text)]">
            {subscribersSummary.data?.total ?? '—'}
          </div>
        </Card>

        <Card
          onClick={() => {
            setSection('marketing');
            setMarketingTab('broadcasts');
          }}
          className="cursor-pointer p-4 hover:border-[var(--color-brand)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Broadcasts</span>
            <Send className="h-4 w-4 text-[var(--color-text-muted)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold text-[var(--color-text)]">
            {campaignsSummary.data?.campaigns.length ?? '—'}
          </div>
        </Card>

        <Card
          onClick={() => {
            setSection('marketing');
            setMarketingTab('sequences');
          }}
          className="cursor-pointer p-4 hover:border-[var(--color-brand)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Sequences</span>
            <ListOrdered className="h-4 w-4 text-[var(--color-text-muted)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold text-[var(--color-text)]">
            {sequencesSummary.data?.sequences.length ?? '—'}
          </div>
        </Card>

        <Card
          onClick={() => {
            setSection('automations');
            setAutomationTab('builder');
          }}
          className="cursor-pointer p-4 hover:border-[var(--color-brand)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Automations</span>
            <Workflow className="h-4 w-4 text-[var(--color-text-muted)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold text-[var(--color-text)]">
            {automationsSummary.data?.automations.length ?? '—'}
          </div>
        </Card>
      </div>

      {/* Primary Domain Navigation Bar */}
      <nav aria-label="Marketing workspace sections" className="flex flex-wrap gap-2 border-b border-[var(--color-border)]">
        <button type="button" onClick={() => setSection('audience')} className={topNavTabClass(section === 'audience')}>
          <Users className="h-4 w-4" /> Audience
        </button>
        <button type="button" onClick={() => setSection('marketing')} className={topNavTabClass(section === 'marketing')}>
          <Mail className="h-4 w-4" /> Email Marketing
        </button>
        <button type="button" onClick={() => setSection('automations')} className={topNavTabClass(section === 'automations')}>
          <Workflow className="h-4 w-4" /> Automations
        </button>
        <button type="button" onClick={() => setSection('growth')} className={topNavTabClass(section === 'growth')}>
          <Globe className="h-4 w-4" /> Growth
        </button>
      </nav>

      {/* Secondary Context Tabs */}
      {section === 'audience' && (
        <div className="space-y-5">
          <div className="inline-flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
            <button type="button" onClick={() => setAudienceTab('subscribers')} className={subNavTabClass(audienceTab === 'subscribers')}>
              <Users className="h-3.5 w-3.5" /> Subscribers
            </button>
            <button type="button" onClick={() => setAudienceTab('tags')} className={subNavTabClass(audienceTab === 'tags')}>
              <Tag className="h-3.5 w-3.5" /> Tags
            </button>
            <button type="button" onClick={() => setAudienceTab('segments')} className={subNavTabClass(audienceTab === 'segments')}>
              <Filter className="h-3.5 w-3.5" /> Segments
            </button>
            <button type="button" onClick={() => setAudienceTab('custom-fields')} className={subNavTabClass(audienceTab === 'custom-fields')}>
              <SlidersHorizontal className="h-3.5 w-3.5" /> Custom Fields
            </button>
            <button type="button" onClick={() => setAudienceTab('import-export')} className={subNavTabClass(audienceTab === 'import-export')}>
              <Upload className="h-3.5 w-3.5" /> Import / Export
            </button>
            <button type="button" onClick={() => setAudienceTab('suppressions')} className={subNavTabClass(audienceTab === 'suppressions')}>
              <Ban className="h-3.5 w-3.5" /> Suppressions
            </button>
          </div>

          {audienceTab === 'subscribers' && (
            <SubscribersSection
              initialTagFilter={tagFilterShortcut}
              onClearInitialTag={() => setTagFilterShortcut(undefined)}
              onOpenImportWizard={handleOpenImportWizard}
              onOpenTagManager={handleOpenTagManager}
            />
          )}
          {audienceTab === 'tags' && <TagsSection onViewSubscribersWithTag={handleViewSubscribersWithTag} />}
          {audienceTab === 'segments' && <SegmentsBuilderSection />}
          {audienceTab === 'custom-fields' && <CustomFieldsSection />}
          {audienceTab === 'import-export' && <ImportExportWizardSection />}
          {audienceTab === 'suppressions' && <SuppressionsSection />}
        </div>
      )}

      {section === 'marketing' && (
        <div className="space-y-5">
          <div className="inline-flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
            <button type="button" onClick={() => setMarketingTab('broadcasts')} className={subNavTabClass(marketingTab === 'broadcasts')}>
              <Send className="h-3.5 w-3.5" /> Broadcasts
            </button>
            <button type="button" onClick={() => setMarketingTab('sequences')} className={subNavTabClass(marketingTab === 'sequences')}>
              <ListOrdered className="h-3.5 w-3.5" /> Sequences
            </button>
            <button type="button" onClick={() => setMarketingTab('templates')} className={subNavTabClass(marketingTab === 'templates')}>
              <FileCode2 className="h-3.5 w-3.5" /> Templates
            </button>
            <button type="button" onClick={() => setMarketingTab('analytics')} className={subNavTabClass(marketingTab === 'analytics')}>
              <BarChart3 className="h-3.5 w-3.5" /> Campaign Analytics
            </button>
          </div>

          {marketingTab === 'broadcasts' && <BroadcastsSection initialMode="broadcasts" />}
          {marketingTab === 'sequences' && <SequencesSection />}
          {marketingTab === 'templates' && <TemplatesStudioSection />}
          {marketingTab === 'analytics' && <BroadcastsSection initialMode="analytics" />}
        </div>
      )}

      {section === 'automations' && (
        <div className="space-y-5">
          <div className="inline-flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
            <button type="button" onClick={() => setAutomationTab('builder')} className={subNavTabClass(automationTab === 'builder')}>
              <Workflow className="h-3.5 w-3.5" /> Visual Automations
            </button>
            <button type="button" onClick={() => setAutomationTab('activity')} className={subNavTabClass(automationTab === 'activity')}>
              <Activity className="h-3.5 w-3.5" /> Automation Activity
            </button>
          </div>

          <AutomationsSection initialTab={automationTab} />
        </div>
      )}

      {section === 'growth' && (
        <div className="space-y-5">
          <div className="inline-flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
            <button type="button" onClick={() => setGrowthTab('forms')} className={subNavTabClass(growthTab === 'forms')}>
              <FileInput className="h-3.5 w-3.5" /> Forms
            </button>
            <button type="button" onClick={() => setGrowthTab('landing-pages')} className={subNavTabClass(growthTab === 'landing-pages')}>
              <Globe className="h-3.5 w-3.5" /> Landing Pages
            </button>
          </div>

          <GrowthSection initialTab={growthTab} />
        </div>
      )}
    </div>
  );
}
