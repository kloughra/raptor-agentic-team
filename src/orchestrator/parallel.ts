import { AgentResult } from "./agents";
import { StepState } from "./state";

export interface ParallelStepResult {
  step: number;
  success: boolean;
  result: AgentResult;
  escalated: boolean;
  blockerDetected: boolean;
}

/**
 * Execute multiple agent tasks in parallel using Promise.allSettled.
 * Each task is a function that returns a ParallelStepResult.
 * All tasks are allowed to complete even if one fails — no cancellation.
 */
export async function executeParallelSteps(
  tasks: Array<() => Promise<ParallelStepResult>>
): Promise<ParallelStepResult[]> {
  const results = await Promise.allSettled(tasks.map((t) => t()));

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    // Rejected promise — agent crashed
    return {
      step: index,
      success: false,
      result: {
        output: result.reason instanceof Error ? result.reason.message : String(result.reason),
        exitCode: 1,
      },
      escalated: false,
      blockerDetected: false,
    };
  });
}

/**
 * Detect parallel step groups in the workflow.
 * Returns groups of step indices that should run together.
 * Steps with matching `parallelWith` values are grouped.
 */
export function detectParallelGroups(
  steps: Array<{ step: number; parallelWith?: number }>
): Map<number, number[]> {
  const groups = new Map<number, number[]>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.parallelWith !== undefined) {
      const groupKey = Math.min(step.step, step.parallelWith);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      const group = groups.get(groupKey)!;
      if (!group.includes(step.step)) {
        group.push(step.step);
      }
      if (!group.includes(step.parallelWith)) {
        group.push(step.parallelWith);
      }
    }
  }

  return groups;
}

/**
 * Check if a step is part of a parallel group.
 */
export function isParallelStep(
  stepNumber: number,
  groups: Map<number, number[]>
): number | null {
  for (const [groupKey, members] of groups.entries()) {
    if (members.includes(stepNumber)) {
      return groupKey;
    }
  }
  return null;
}

/**
 * Aggregate parallel step results to determine group outcome.
 */
export function aggregateParallelResults(
  results: ParallelStepResult[]
): { allSucceeded: boolean; anyEscalated: boolean; anyBlocker: boolean } {
  return {
    allSucceeded: results.every((r) => r.success),
    anyEscalated: results.some((r) => r.escalated),
    anyBlocker: results.some((r) => r.blockerDetected),
  };
}
