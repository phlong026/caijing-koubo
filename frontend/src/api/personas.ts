import { apiGet } from './client'

export type PersonaLine = 'manager' | 'kos' | 'persona'

export interface IpProfile {
  role: string
  serviceScope: string
  targetAudience: string
  expressionStyle: string
  forbiddenClaims: string[]
}

export interface Persona {
  id: string
  name: string
  line: PersonaLine
  enabled: boolean
  ipProfile: IpProfile
}

export function getPersonas() {
  return apiGet<Persona[]>('/personas')
}
