import type { ServiceIndustryPack } from '../domain/industryPack.ts';
import { exteriorServicesIndustryPack } from './exteriorServiceTemplates.ts';
import { residentialCleaningIndustryPack } from './residentialServiceTemplates.ts';

export const serviceIndustryPacks = [
  exteriorServicesIndustryPack,
  residentialCleaningIndustryPack,
] as const satisfies readonly ServiceIndustryPack[];

export type ServiceIndustryPackCode = (typeof serviceIndustryPacks)[number]['code'];

export function getServiceIndustryPack(code: string): ServiceIndustryPack | undefined {
  return serviceIndustryPacks.find((candidate) => candidate.code === code);
}
