import type { DemoIncident } from './model';

export const unresolvedIncidentStatuses = ['open', 'investigating', 'corrective_action'] as const;

export function isUnresolvedIncidentStatus(status: string): boolean {
  return (unresolvedIncidentStatuses as readonly string[]).includes(status);
}

export interface IncidentVisitScope {
  visitId: string;
  jobId?: string;
  propertyId?: string;
}

/**
 * Mirrors storyops_visit_has_open_incident exactly: a visit is stopped by an
 * incident linked directly to it, linked to its job, or linked only to its
 * property. A property value on an incident that already names a visit/job
 * must not accidentally broaden the stop to unrelated work.
 */
export function incidentAffectsVisit(
  incident: Pick<DemoIncident, 'visitId' | 'jobId' | 'propertyId'>,
  scope: IncidentVisitScope,
): boolean {
  return (
    incident.visitId === scope.visitId ||
    (Boolean(incident.jobId) && incident.jobId === scope.jobId) ||
    (!incident.visitId &&
      !incident.jobId &&
      Boolean(incident.propertyId) &&
      incident.propertyId === scope.propertyId)
  );
}

export function unresolvedIncidentForVisit(
  incidents: readonly DemoIncident[],
  scope: IncidentVisitScope,
): DemoIncident | undefined {
  return incidents.find(
    (incident) => incident.status !== 'closed' && incidentAffectsVisit(incident, scope),
  );
}
