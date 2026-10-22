"use client";

import { useState, useMemo } from "react";
import { DecisionBadge } from "@/components/decision-badge";
import type { ScenarioEvaluation } from "@/lib/scenarios/evaluate";
import { demoScenarios } from "@/lib/scenarios/seed";
import type { Scenario } from "@/lib/types/domain";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ScenariosCatalog({ evaluations }: { evaluations: ScenarioEvaluation[] }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDecision, setSelectedDecision] = useState<string>("ALL");

  /** The decision the engine currently produces - not the hard-coded seed label. */
  const engineDecision = (scenario: Scenario) =>
    evaluations.find((evaluation) => evaluation.scenario.id === scenario.id)?.actual ??
    scenario.expectedDecision;

  const filteredScenarios = useMemo(() => {
    const evaluationByScenario = new Map(
      evaluations.map((evaluation) => [evaluation.scenario.id, evaluation])
    );

    return demoScenarios.filter((scenario) => {
      const query = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !query ||
        scenario.title.toLowerCase().includes(query) ||
        scenario.description.toLowerCase().includes(query) ||
        scenario.action.target.toLowerCase().includes(query) ||
        scenario.action.domain.toLowerCase().includes(query) ||
        (scenario.action.tool?.toLowerCase().includes(query) ?? false);

      const actualDecision =
        evaluationByScenario.get(scenario.id)?.actual ?? scenario.expectedDecision;
      const matchesDecision = selectedDecision === "ALL" || actualDecision === selectedDecision;

      return matchesSearch && matchesDecision;
    });
  }, [evaluations, searchQuery, selectedDecision]);

  const clearFilters = () => {
    setSearchQuery("");
    setSelectedDecision("ALL");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Input
            type="text"
            placeholder="Search scenarios..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full"
            id="scenario-search-input"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {["ALL", "APPROVE", "WARN", "REQUIRE_APPROVAL", "BLOCK"].map((decision) => (
            <Button
              key={decision}
              variant={selectedDecision === decision ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedDecision(decision)}
              className="capitalize"
              id={`filter-${decision.toLowerCase()}`}
            >
              {decision === "ALL" ? "All" : decision.replace("_", " ").toLowerCase()}
            </Button>
          ))}
        </div>
      </div>

      {filteredScenarios.length === 0 ? (
        <div
          className="surface-elevated flex flex-col items-center justify-center p-12 text-center border border-dashed border-[hsl(var(--border))] rounded-2xl"
          id="scenario-empty-state"
        >
          <div className="mb-4 rounded-full bg-[hsl(var(--muted)/0.5)] p-4 text-[hsl(var(--muted-foreground))]">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-8 w-8 opacity-75"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.608 10.608Z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-medium text-[hsl(var(--foreground))]">
            No scenarios match your current filters.
          </h3>
          <p className="mb-6 text-sm text-[hsl(var(--muted-foreground))] max-w-sm">
            Try clearing your search or filters to see all available scenarios.
          </p>
          <Button variant="outline" size="sm" onClick={clearFilters} id="clear-filters-btn">
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredScenarios.map((scenario) => (
            <div
              key={scenario.id}
              data-scenario-id={scenario.id}
              className="surface-elevated p-5 transition hover:border-[hsl(var(--accent)/0.15)]"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <p className="font-medium">{scenario.title}</p>
                <DecisionBadge decision={engineDecision(scenario)} />
              </div>
              <p className="mb-4 text-sm text-[hsl(var(--muted-foreground))]">
                {scenario.description}
              </p>
              <dl className="grid gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                <div className="flex justify-between border-t border-[hsl(var(--border)/0.5)] pt-2">
                  <dt>Target</dt>
                  <dd className="font-mono text-[hsl(var(--foreground))]">
                    {scenario.action.target}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Domain</dt>
                  <dd>{scenario.action.domain}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Amount</dt>
                  <dd>{scenario.action.amountXLM} XLM</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Engine decision</dt>
                  <dd data-engine-decision={scenario.id}>{engineDecision(scenario)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
