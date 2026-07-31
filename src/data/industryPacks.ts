import type { ServiceIndustryPack } from '@/domain';
import { exteriorServicesIndustryPack } from './exteriorServiceTemplates.ts';

export const serviceIndustryPacks = [
  exteriorServicesIndustryPack,
] satisfies readonly ServiceIndustryPack[];

export type ServiceIndustryPackCode = (typeof serviceIndustryPacks)[number]['code'];

export function getServiceIndustryPack(code: ServiceIndustryPackCode): ServiceIndustryPack {
  const pack = serviceIndustryPacks.find((candidate) => candidate.code === code);
  if (!pack) {
    throw new Error(`Service industry pack "${code}" is not registered.`);
  }
  return pack;
}
