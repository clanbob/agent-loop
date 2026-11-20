Choose which agent should act first based only on the wording of the user's request.

<request>
{{task}}
</request>

Choose "review" when the user asks to inspect, diagnose or audit existing work. This includes requests to fix whatever the review uncovers. The reviewer will locate the relevant code and produce the findings.

Choose "build" when the user asks for a specific change or new capability. If the starting step is unclear, choose "build".

Return only the mode and a one-sentence reason. This routing decision requires no tools, file inspection, findings or work plan.
