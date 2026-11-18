// The fault hook production code calls at named places. The default does nothing. Tests supply an armed
// implementation (`Faults`, in the test-support package); production never loads that package.
export interface FaultHook {
  hit(name: string): Promise<void>;
}
export const NO_FAULTS: FaultHook = { hit: () => Promise.resolve() };
