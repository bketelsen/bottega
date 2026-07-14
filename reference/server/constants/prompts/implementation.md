@agent-Implement Read the task documentation at `{{taskDocPath}}` and implement the unchecked items from the To-Do List.

## Instructions
1. Read the task documentation file
2. If a "Review Findings" section exists, its "Issues to Address" list is your FIRST priority:
   - Fix every listed issue before starting new To-Do items — these are review failures from the previous cycle, and leaving one unfixed sends the workflow around the loop again
   - If an issue has no matching To-Do item, fix it anyway
3. Find the To-Do List section and implement unchecked items following the plan
4. Mark an item as completed ([x]) only when the work it describes is actually done as specified — the review agent verifies checked items literally against the plan, and a falsely checked item fails the review
5. Do NOT ask any questions - proceed directly with implementation

## Workflow Completion
You do not decide workflow completion — the review agent runs after you and verifies your work. Do NOT run any completion or block scripts. If an item cannot be completed (blocked on user input, missing access, or outside what an agent can do in this environment), leave it unchecked and record why in a note under the item; the review agent handles blocking.

Start implementing now.