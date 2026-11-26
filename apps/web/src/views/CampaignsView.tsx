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
  const [section, setSection] = useState<TopSection>('marketing');
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

  const pillButtonClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-sm'
        : 'border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--fg-secondary)] hover:border-[var(--border-default)] hover:text-[var(--fg-primary)]'
    }`;

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--fg-primary)]">
            Audience &amp; Email Marketing
          </h1>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            One unified subscriber audience organized by tags, custom fields, and dynamic segments — powering broadcasts, drip sequences, visual automations, and signup forms.
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
          className="cursor-pointer p-3.5 hover:border-[var(--accent)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--fg-muted)]">Subscribers</span>
            <Users className="h-4 w-4 text-[var(--fg-muted)]" />
          </div>
          <div className="mt-1 text-2xl font-semibold text-[var(--fg-primary)]">
            {subscribersSummary.data?.total ?? '—'}
          </div>
        </Card>

        <Card
          onClick={() => {
            setSection('marketing');
            setMarketingTab('broadcasts');
          }}
          className="cursor-pointer p-3.5 hover:border-[var(--accent)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--fg-muted)]">Broadcasts</span>
            <Send className="h-4 w-4 text-[var(--fg-muted)]" />
          </div>
          <div className="mt-1 text-2xl font-semibold text-[var(--fg-primary)]">
            {campaignsSummary.data?.campaigns.length ?? '—'}
          </div>
        </Card>

        <Card
          onClick={() => {
            setSection('marketing');
            setMarketingTab('sequences');
          }}
          className="cursor-pointer p-3.5 hover:border-[var(--accent)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--fg-muted)]">Sequences</span>
            <ListOrdered className="h-4 w-4 text-[var(--fg-muted)]" />
          </div>
          <div className="mt-1 text-2xl font-semibold text-[var(--fg-primary)]">
            {sequencesSummary.data?.sequences.length ?? '—'}
          </div>
        </Card>

        <Card
          onClick={() => {
            setSection('automations');
            setAutomationTab('builder');
          }}
          className="cursor-pointer p-3.5 hover:border-[var(--accent)] transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--fg-muted)]">Automations</span>
            <Workflow className="h-4 w-4 text-[var(--fg-muted)]" />
          </div>
          <div className="mt-1 text-2xl font-semibold text-[var(--fg-primary)]">
            {automationsSummary.data?.automations.length ?? '—'}
          </div>
        </Card>
      </div>

      {/* Primary Domain Navigation (4 Clear Pillars) */}
      <div className="flex flex-wrap gap-2 border-b border-[var(--border-subtle)] pb-3">
        <button
          type="button"
          onClick={() => setSection('audience')}
          className={pillButtonClass(section === 'audience')}
        >
          <Users className="h-3.5 w-3.5" /> Audience
        </button>
        <button
          type="button"
          onClick={() => setSection('marketing')}
          className={pillButtonClass(section === 'marketing')}
        >
          <Mail className="h-3.5 w-3.5" /> Email Marketing
        </button>
        <button
          type="button"
          onClick={() => setSection('automations')}
          className={pillButtonClass(section === 'automations')}
        >
          <Workflow className="h-3.5 w-3.5" /> Automations
        </button>
        <button
          type="button"
          onClick={() => setSection('growth')}
          className={pillButtonClass(section === 'growth')}
        >
          <Globe className="h-3.5 w-3.5" /> Growth
        </button>
      </div>

      {/* Secondary Context Tabs */}
      {section === 'audience' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setAudienceTab('subscribers')}
              className={pillButtonClass(audienceTab === 'subscribers')}
            >
              <Users className="h-3.5 w-3.5" /> Subscribers
            </button>
            <button
              type="button"
              onClick={() => setAudienceTab('tags')}
              className={pillButtonClass(audienceTab === 'tags')}
            >
              <Tag className="h-3.5 w-3.5" /> Tags
            </button>
            <button
              type="button"
              onClick={() => setAudienceTab('segments')}
              className={pillButtonClass(audienceTab === 'segments')}
            >
              <Filter className="h-3.5 w-3.5" /> Segments
            </button>
            <button
              type="button"
              onClick={() => setAudienceTab('custom-fields')}
              className={pillButtonClass(audienceTab === 'custom-fields')}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" /> Custom Fields
            </button>
            <button
              type="button"
              onClick={() => setAudienceTab('import-export')}
              className={pillButtonClass(audienceTab === 'import-export')}
            >
              <Upload className="h-3.5 w-3.5" /> Import / Export
            </button>
            <button
              type="button"
              onClick={() => setAudienceTab('suppressions')}
              className={pillButtonClass(audienceTab === 'suppressions')}
            >
              <Ban className="h-3.5 w-3.5" /> Suppressions
            </button>
          </div>

          {audienceTab === 'subscribers' && (
            <SubscribersSection
              initialTagFilter={tagFilterShortcut}
              onClearInitialTag={() => setTagFilterShortcut(undefined)}
              onOpenImportWizard={handleOpenImportWizard}
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
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setMarketingTab('broadcasts')}
              className={pillButtonClass(marketingTab === 'broadcasts')}
            >
              <Send className="h-3.5 w-3.5" /> Broadcasts
            </button>
            <button
              type="button"
              onClick={() => setMarketingTab('sequences')}
              className={pillButtonClass(marketingTab === 'sequences')}
            >
              <ListOrdered className="h-3.5 w-3.5" /> Sequences
            </button>
            <button
              type="button"
              onClick={() => setMarketingTab('templates')}
              className={pillButtonClass(marketingTab === 'templates')}
            >
              <FileCode2 className="h-3.5 w-3.5" /> Templates
            </button>
            <button
              type="button"
              onClick={() => setMarketingTab('analytics')}
              className={pillButtonClass(marketingTab === 'analytics')}
            >
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
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setAutomationTab('builder')}
              className={pillButtonClass(automationTab === 'builder')}
            >
              <Workflow className="h-3.5 w-3.5" /> Visual Automations
            </button>
            <button
              type="button"
              onClick={() => setAutomationTab('activity')}
              className={pillButtonClass(automationTab === 'activity')}
            >
              <Activity className="h-3.5 w-3.5" /> Automation Activity
            </button>
          </div>

          <AutomationsSection initialTab={automationTab} />
        </div>
      )}

      {section === 'growth' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setGrowthTab('forms')}
              className={pillButtonClass(growthTab === 'forms')}
            >
              <FileInput className="h-3.5 w-3.5" /> Forms
            </button>
            <button
              type="button"
              onClick={() => setGrowthTab('landing-pages')}
              className={pillButtonClass(growthTab === 'landing-pages')}
            >
              <Globe className="h-3.5 w-3.5" /> Landing Pages
            </button>
          </div>

          <GrowthSection initialTab={growthTab} />
        </div>
      )}
    </div>
  );
}
