# 1. Conflict resolution
You are working on the existing TrajX ATC Fast-Time Simulation Tool.

Your task is to improve the existing Conflict Resolution system, especially the handling of Primary Conflict and Secondary Conflict.

IMPORTANT:

* Do NOT redesign the entire application.
* Do NOT replace the existing conflict detection system unless necessary.
* Reuse the existing trajectory, conflict detection, separation minima, aircraft state, and map logic.
* First inspect the existing code and understand the current data flow before modifying anything.
* Preserve all existing working features.
* Do not introduce AI/ML yet. Implement a deterministic candidate-based resolution system first.

## 1. Goal

Build a robust Conflict Resolution workflow:

Primary Conflict
→ Generate resolution candidates
→ Forward simulate each candidate
→ Check against ALL relevant aircraft
→ Detect Secondary Conflicts
→ Reject unsafe candidates
→ Recalculate if necessary
→ Rank valid candidates
→ Return the best valid resolution

The system must not solve only the original aircraft pair.

Example:

Aircraft A conflicts with B.

A resolution changes A's trajectory.

The new trajectory of A must then be checked against:

* B
* C
* D
* E
* and every other relevant aircraft within the prediction horizon.

If A's new trajectory conflicts with C, this is a Secondary Conflict and the candidate must be rejected or modified.

## 2. Existing Conflict Detection Must Remain the Safety Gate

Do not assume that a candidate is safe because it resolves the original conflict.

Every candidate must pass the existing conflict detection/separation logic.

Use the existing:

* horizontal separation minimum
* vertical separation minimum
* CPA / closest-point logic
* conflict time window
* aircraft trajectory prediction
* altitude/level constraints
* existing conflict severity classification

Do not create a second incompatible definition of "conflict".

## 3. Candidate Generation

Generate multiple deterministic resolution candidates.

At minimum:

### Heading

Generate:

* left turn
* right turn
* several heading offsets

Example offsets:

* ±5°
* ±10°
* ±15°
* ±30°
* ±45°

Use the existing aircraft/trajectory logic where possible.

### Speed

Generate reasonable speed changes based on the existing aircraft speed constraints.

Examples:

* small reduction
* small increase
* moderate reduction
* moderate increase

Do not exceed existing aircraft or flight-phase speed constraints.

### Level

Generate reasonable altitude/flight-level changes.

Examples:

* one level up
* one level down
* larger valid level changes where permitted

Respect:

* aircraft performance
* minimum/maximum altitude
* flight level constraints
* route/procedure constraints
* existing airspace restrictions

### Direct / DCT

If the current system supports DCT or direct-to-fix resolution, generate valid direct candidates using the existing route/trajectory infrastructure.

Do not create geometrically invalid shortcuts.

## 4. Forward Simulation

For every candidate:

1. Apply the resolution to the affected aircraft.
2. Rebuild/recalculate its future trajectory.
3. Simulate forward through the existing prediction horizon.
4. Compare the modified trajectory against all relevant aircraft trajectories.
5. Detect conflicts again.

Conceptually:

candidate
→ modified trajectory
→ forward simulation
→ conflict detection
→ primary conflict?
→ secondary conflict?
→ additional conflict?
→ candidate valid/rejected

Do not only check the original conflicting pair.

## 5. Secondary Conflict Handling

Implement iterative secondary-conflict filtering.

Example:

A conflicts with B.

Candidate:
A turns right 15°.

After simulation:

A no longer conflicts with B.

But:

A now conflicts with C.

Therefore:

Candidate = REJECTED.

Then test another candidate.

If necessary:

A resolution
→ Secondary Conflict with C
→ add C-related constraint
→ generate another candidate
→ simulate again
→ check A against B/C/D/E...
→ repeat until:

* a valid candidate is found, or
* no valid candidate remains.

Do NOT use the phrase "100% safe".

Instead, the implementation should guarantee that the candidate satisfies the configured separation constraints for the simulated horizon and conditions.

## 6. Relevant Aircraft Filtering

Do not blindly compare every aircraft if that causes performance problems.

Use an efficient broad-phase filter first.

Possible filters:

* spatial proximity
* altitude band
* time overlap
* prediction horizon
* existing conflict/traffic relevance logic

Then perform the expensive trajectory conflict calculation only on relevant aircraft.

However, correctness is more important than premature optimization.

Do not accidentally filter out an aircraft that can become a secondary conflict.

## 7. Candidate Cost Function

After safety filtering, rank only candidates that pass all safety checks.

Use a deterministic cost function such as:

Cost =
trajectory deviation

* delay
* heading change
* speed change
* altitude change
* route deviation
* operational penalty

Do not assign a candidate a low cost if it creates any unresolved conflict.

Example:

if unresolvedConflict:
candidate.valid = false

Otherwise calculate the cost.

The exact weights should be configurable rather than hard-coded throughout the code.

## 8. Resolution Priority

Do not assume that heading is always better than speed or level.

Generate candidates from multiple resolution dimensions and allow the cost function to rank valid candidates.

The system should be able to return something like:

1. Heading +10° — valid
2. Heading -15° — valid
3. Speed -10 kt — valid
4. Level +20 — valid

Only valid candidates should be ranked.

## 9. Resolution Result

Return structured information for the selected resolution.

Include at minimum:

* affected aircraft
* resolution type
* original trajectory
* modified trajectory
* primary conflict
* secondary conflicts detected
* conflicts resolved
* conflicts remaining
* candidate cost
* resolution parameters
* simulation horizon
* validation status

Example structure:

{
aircraft: "SIA113",
resolutionType: "HEADING",
headingChange: 15,
valid: true,
primaryConflictResolved: true,
secondaryConflicts: [],
remainingConflicts: [],
cost: 123.4
}

Adapt this structure to the existing project's types instead of introducing unnecessary duplicate models.

## 10. UI Requirements

Do not redesign the UI.

Use the existing Conflict UI.

When the user selects a conflict, show the available valid resolution candidates using the existing UI components where possible.

The UI should clearly distinguish:

* Primary Conflict
* Secondary Conflict
* Resolved
* Unresolved
* Candidate
* Applied Resolution

If a candidate creates a secondary conflict, do not present it as a valid resolution.

## 11. Important Edge Cases

Handle:

* no valid resolution
* multiple simultaneous conflicts
* cascading secondary conflicts
* aircraft already in conflict with multiple aircraft
* resolution creating another conflict later in the prediction horizon
* resolution creating an earlier conflict
* invalid altitude
* invalid speed
* invalid heading
* trajectory leaving the valid airspace
* route/procedure constraints
* conflict disappearing temporarily and returning later
* two candidates having similar cost
* insufficient prediction horizon

Do not silently mark a failed resolution as resolved.

## 12. Performance

This application may simulate thousands of flights.

Avoid:

* unnecessary full trajectory reconstruction
* repeated parsing of static data
* duplicated GeoJSON loading
* O(N²) checks when an existing spatial/indexing mechanism can be reused
* recalculating unchanged aircraft trajectories

Reuse cached/static data where possible.

First make the algorithm correct, then optimize bottlenecks based on the existing code.

## 13. Testing

Before modifying code, inspect the existing tests and add focused tests for:

### Test 1

A conflicts with B.

A heading change resolves A-B.

Expected:
Primary conflict resolved.

### Test 2

A conflicts with B.

A heading change resolves A-B but creates A-C.

Expected:
Candidate rejected as Secondary Conflict.

### Test 3

Candidate 1 creates secondary conflict.

Candidate 2 resolves the primary conflict without creating secondary conflicts.

Expected:
Candidate 2 selected.

### Test 4

A has conflicts with B and C simultaneously.

Expected:
Resolution must consider both conflicts.

### Test 5

No candidate satisfies separation constraints.

Expected:
Return "No valid resolution", not "Resolved".

### Test 6

Resolution temporarily removes a conflict but creates another conflict later in the prediction horizon.

Expected:
Candidate rejected.

## 14. Logging / Debugging

Add useful structured logs for the resolution process.

Example:

[ConflictResolution]
Primary: A-B

[Candidate]
A heading +15°

[ForwardSimulation]
Primary conflict: RESOLVED

[SecondaryCheck]
A-C: CONFLICT

[Candidate]
REJECTED

Then:

[Candidate]
A heading -15°

[ForwardSimulation]
A-B: RESOLVED
A-C: CLEAR
A-D: CLEAR

[Candidate]
VALID

This should make it possible to understand why a candidate was rejected.

## 15. Architecture

Prefer this logical separation:

Conflict Detection
↓
Conflict Resolution
↓
Candidate Generation
↓
Forward Simulation
↓
Secondary Conflict Detection
↓
Candidate Validation
↓
Candidate Ranking
↓
Resolution Result

Do not mix UI logic with trajectory/conflict calculation.

Keep the core resolution algorithm reusable from:

* UI
* API
* tests
* future automated simulation

## 16. Future AI Compatibility

Design the interfaces so that AI/ML can be added later.

For example:

Candidate Generator

* Deterministic generator now
* AI generator later

Candidate Ranker

* Cost-function ranking now
* ML ranking later

Safety Validator

* Existing deterministic conflict detection

The deterministic Safety Validator must remain independent from any future AI component.

## 17. Before Coding

First inspect:

1. Existing conflict detection
2. Existing trajectory representation
3. Existing aircraft state model
4. Existing separation minima
5. Existing CPA logic
6. Existing resolution code
7. Existing conflict UI
8. Existing API endpoints
9. Existing caching / trajectory recalculation
10. Existing tests

Then explain briefly:

* where the current conflict resolution starts
* how trajectories are represented
* how conflicts are currently detected
* where Secondary Conflict handling is missing
* which files need modification
* which files should NOT be modified

Only after that, implement the changes.

Do not rewrite unrelated parts of the project.

## Final Acceptance Criteria

The implementation is complete only if:

1. A primary conflict can generate multiple resolution candidates.
2. Every candidate is forward-simulated.
3. Every modified trajectory is checked against relevant surrounding aircraft.
4. Secondary conflicts are detected.
5. Candidates causing secondary conflicts are rejected or recalculated.
6. Only candidates satisfying all configured separation constraints can be marked valid.
7. Valid candidates can be ranked using a deterministic cost function.
8. "No valid resolution" is handled explicitly.
9. Existing conflict detection remains the authoritative safety check.
10. Existing TrajX features continue to work.
11. Tests cover primary + secondary + cascading conflict scenarios.
12. The architecture remains ready for future optimization/AI without making AI responsible for the final safety validation.
  vs
# 2. Conflict Resolution
แก้conflict
ผมขอแบ่งออกเป็น 2 ส่วนหลักๆ คือ กระบวนการคิดของมนุษย์ (ATC Decision-Making Process) และ กลไกของสมองกล (Automated/AI Resolution Algorithm) ซึ่งทั้งสองส่วนนี้ทำงานผสานกันในห้องควบคุมจราจรทางอากาศยุคใหม่ครับ1. ขั้นตอนการตัดสินใจของ ATC (Human Controller's Perspective)เมื่อเกิด Conflict ที่มี Secondary Conflict ซ้อนอยู่ ATC จะใช้กระบวนการคิดที่เป็นระบบ (Scanning & Planning) ภายในเวลาไม่กี่วินาที ดังนี้:1. Information Gathering (สแกนและรับรู้): ATC มองหน้าจอเรดาร์และฟังเสียงแจ้งเตือนจากระบบเครื่องมือ (เช่น STCA หรือ MTCD) เพื่อระบุ "ใคร ขัดแย้งกับ ใคร ที่ไหน และเมื่อไหร่"2. Consequence Analysis (วิเคราะห์ผลกระทบต่อเนื่อง): ก่อนจะสั่งเครื่องบินลำ A หลบเครื่องบินลำ B สายตาของ ATC จะต้อง "มองข้ามช็อต" ไปยังเครื่องบินลำ C, D หรือ E ที่อยู่ในรัศมีใกล้เคียง เพื่อดูว่าทิศทางที่จะให้หลบนั้นมีพื้นที่ว่างพอหรือไม่3. Option Generation (คิดหาทางเลือก): ATC จะคิดแผนแก้ปัญหาไว้ในใจมากกว่า 1 แผนเสมอ:แผน A (แนวราบ): ให้เลี้ยวหลบ (Heading)แผน B (แนวดิ่ง): ให้เปลี่ยนความสูง (Altitude)แผน C (เวลา): ให้ลดความเร็ว (Speed)4. Secondary Conflict Filtering (คัดกรองแผน): ATC จะทดลองนำแผนเหล่านั้นเข้าฟังก์ชัน "What-If Probe" บนระบบคอมพิวเตอร์ เพื่อให้ระบบประเมินว่าแผนไหนจะไม่สร้าง Secondary Conflict หรือถ้าสร้าง จะเป็นแผนที่ควบคุมได้ง่ายที่สุด5. Execution & Monitoring (สั่งการและเฝ้าดู): ออกคำสั่ง Clearance แก่นักบิน และจับตาดูหน้าจออย่างใกล้ชิดว่าเครื่องบินเคลื่อนที่ตามแผนและพ้นจากความเสี่ยงทั้งปวงจริงหรือไม่

2. อัลกอริทึมของระบบอัตโนมัติ (Automated / AI Resolution Algorithm)สำหรับระบบอัตโนมัติ (เช่น ระบบ CD&R - Conflict Detection and Resolution) การแก้ปัญหาที่มี Secondary Conflict ถือเป็นโจทย์แบบ Multi-Agent Optimization ซึ่งอัลกอริทึมจะคำนวณผ่านขั้นตอนเหล่านี้: [ตรวจพบ Primary Conflict] 
       │
       ▼
[คำนวณพื้นที่ปลอดภัย (Search Space)] 
       │
       ▼
[สร้างเส้นทางแก้ปัญหา (Trajectory Generation)] 
       │
       ▼
[จำลองเส้นทางใหม่ล่วงหน้า (Forward Simulation)] ──► พบ Secondary Conflict?
       │                                                 │
       ├─── (ไม่ใช่) ─── [ส่งผลลัพธ์ให้ ATC]              └─── (ใช่) ─── ดึงข้อจำกัด (Constraints) กลับไปคำนวณใหม่
Step 1: Trajectory Prediction & Conflict Detection ระบบใช้ค่า 4D Trajectory Predictor (ละติจูด, ลองจิจูด, ความสูง, เวลา) คำนวณล่วงหน้าไป 5–20 นาที เพื่อหาจุดตัดที่ระยะห่างต่ำกว่าเกณฑ์ (Separation Minima) Step 2: Search Space Generation เมื่อเจอ Primary Conflict ระบบจะสร้าง "กล่องข้อจำกัด" (Constraints Area) ขึ้นมาล้อมรอบเครื่องบินคู่นั้น เพื่อหาว่ามีพื้นที่ตรงไหนที่เหลือให้บินได้บ้าง Step 3: Resolution & Secondary Filtering (กลไกหลักของ AI) อัลกอริทึมส่วนใหญ่ (เช่น Mathematical Programming, Genetic Algorithms หรือ Reinforcement Learning) จะใช้ฟังก์ชันที่เรียกว่า Multi-Criteria Cost Function ในการคำนวณ โดยตั้งเป้าหมายว่า: \[\text{Cost}=(\text{การใช้น้ำมันเพิ่ม})+(\text{เวลาที่ล่าช้า})+(\text{คะแนนความเสี่ยงที่จะเกิด Secondary Conflict})\]Forward Simulation: AI จะสร้างเส้นทางหลบเลี่ยง (Resolution Trajectory) ขึ้นมาหนึ่งเส้นทาง แล้วกด "Fast-Forward" จำลองภาพอนาคตทันทีว่าเส้นทางนี้ไปขัดแย้งกับลำอื่นหรือไม่ Iterative Loop: หากพบว่าเส้นทางใหม่ทำให้เกิด Secondary Conflict อัลกอริทึมจะเพิ่มตำแหน่งของเครื่องบินลำที่ 3 เข้าไปเป็น "ข้อจำกัดห้ามเข้า" (No-Fly Zone Constraint) ตัวใหม่ทันที แล้วทำการคำนวณวนซ้ำ (Re-optimize) จนกว่าจะได้เส้นทางที่ปลอดความเสี่ยง 100% Step 4: Solution Ranking ระบบอัตโนมัติจะไม่ได้เลือกคำตอบเดียว แต่จะเสนอ 2-3 ทางเลือกที่ดีที่สุด (เช่น ทางเลือกที่ประหยัดน้ำมันที่สุด หรือทางเลือกที่นักบินเปลี่ยนทิศทางน้อยที่สุด) ขึ้นมาบนหน้าจอเพื่อให้ ATC มนุษย์เป็นผู้กดอนุมัติ (Human-in-the-loop) 

ประเภทของอัลกอริทึม ที่ใช้แก้ปัญหา Conflict และ Secondary Conflict ในระบบจัดการจราจรทางอากาศ (CD&R) ความท้าทายหลักคือการจัดการกับ State Space ที่ซับซ้อนขึ้นแบบทวีคูณ (Combinatorial Explosion) เมื่อมีเครื่องบินลำที่ 3, 4 เข้ามาเกี่ยวข้องนี่คือการเปรียบเทียบเชิงลึกระหว่างสองแนวคิดหลัก: Geometric Approach (ดั้งเดิม/คณิตศาสตร์รูปทรง) และ AI / Machine Learning (ยุคใหม่/เรียนรู้พฤติกรรม) ครับ1. Geometric Approach (แนวคิดเชิงเรขาคณิตและคณิตศาสตร์ข้อจำกัด)แนวคิดนี้มองเครื่องบินเป็นจุดหรือวงกลม (Protection Zone) ที่เคลื่อนที่บนพิกัดความเร็วและเวลา โดยใช้กฎทางฟิสิกส์และเรขาคณิตบริสุทธิ์ในการหาทางออกวิธีการทำงานกับ Secondary Conflict:Velocity Obstacle (VO) / Reciprocal Velocity Obstacles (RVO): อัลกอริทึมจะคำนวณ "กรวยความเร็วที่ห้ามเลือก" (Forbidden Velocities) ของเครื่องบินคู่แรก หากเลือกความเร็วหรือทิศทางในกรวยนี้จะชนกันแน่ๆเมื่อมีเครื่องบินลำที่สาม (Secondary Conflict) ระบบจะสร้างกรวยข้อจำกัดของลำที่สามซ้อนทับลงไป (Overlay) บนแผนที่ความเร็วเดียวกัน อัลกอริทึมจะมองหา "พื้นที่ว่างที่ไม่มีกรวยใดบังอยู่เลย" (Intersection of Safe Velocities) แล้วเลือกเวกเตอร์ความเร็วที่ใกล้เคียงกับเป้าหมายเดิมที่สุดจุดเด่น:Deterministic & Provable: คำตอบที่ได้มีความแน่นอนและสามารถพิสูจน์ได้ทางคณิตศาสตร์ว่าปลอดภัย 100% ภายใต้เงื่อนไขที่กำหนดLow Computation Time: ใช้พลังงานประมวลผลต่ำมากสำหรับเครื่องบินจำนวนน้อย สรุปผลได้ในระดับมิลลิวินาทีจุดอ่อนเมื่อเจอ Secondary Conflict:Deadlock / No Solution: หากน่านฟ้าหนาแน่นมาก กรวยข้อจำกัดอาจจะทับซ้อนกันจนระบบหาทางออกไม่ได้ (Safe Space กลายเป็นศูนย์) ทั้งที่ในความเป็นจริงอาจจะแก้ได้ด้วยการไต่ระดับความสูง2. AI / Machine Learning Approach (แนวคิดปัญญาประดิษฐ์และการเรียนรู้)แนวคิดยุคใหม่ไม่ได้คำนวณสมการเพื่อหาคำตอบตายตัว แต่ใช้การสุ่ม ค้นหา หรือให้เอเจนต์เรียนรู้ลองผิดลองถูกผ่านสถานการณ์จำลองนับล้านครั้งวิธีการทำงานกับ Secondary Conflict:Deep Reinforcement Learning (DRL): นิยมใช้โมเดลแบบ Multi-Agent DRL (MADRL) เครื่องบินแต่ละลำคือ 1 Agent โดยมีระบบส่วนกลางควบคุม (Centralized or Distributed)เมื่อเกิด Primary และ Secondary Conflict ตัว AI จะได้โมเดลการคำนวณค่า Reward/Penalty Function เช่น หากเครื่องบินขยับหลบเครื่องบินลำที่ 2 แต่ส่งผลให้ระยะห่างจากเครื่องบินลำที่ 3 ลดลง (เกิด Secondary Conflict) AI จะโดนหักคะแนนอย่างรุนแรง (Heavy Penalty)AI จะเรียนรู้ที่จะเลือกเส้นทาง "อ้อมโค้งที่สมดุล" (Coordinated Maneuver) ซึ่งอาจจะไม่ใช่เส้นตรงที่สั้นที่สุดทางเรขาคณิต แต่เป็นเส้นทางที่ทำให้ฝูงบินทั้งหมดลื่นไหลที่สุดMetaheuristic (Genetic Algorithms / Particle Swarm): มองปัญหานี้เป็นสมการ Optimization ขนาดใหญ่ ระบบจะสุ่มเส้นทางหลบขึ้นมาหลายร้อยแบบ แล้วคัดเลือกเส้นทางที่ไม่มี Secondary Conflict มารวมร่างกัน (Crossover) จนได้เส้นทางที่ดีที่สุดจุดเด่น:Highly Scalable: จัดการกับปัญหาเครื่องบินหลายสิบลำพร้อมๆ กันในน่านฟ้าที่หนาแน่นได้ดีกว่าเกณฑ์เรขาคณิตMulti-Dimensional Integration: สามารถรวมเงื่อนไขความสูง ทิศทาง ความเร็ว และอัตราสิ้นเปลืองน้ำมัน เข้าไปคำนวณพร้อมกันได้อย่างง่ายดายจุดอ่อนเมื่อเจอ Secondary Conflict:Black Box Issue: ไม่สามารถพิสูจน์สูตรคณิตศาสตร์ได้ว่าทำไม AI ถึงเลือกเลี้ยวทิศนี้ ซึ่งเป็นเรื่องยากในการผ่านเกณฑ์มาตรฐานความปลอดภัยการบิน (Certification)Training Dependency: หากเจอสถานการณ์ที่แปลกประหลาดมากและไม่เคยอยู่ในข้อมูลที่ใช้ฝึกฝน (Edge Case) AI อาจให้คำตอบที่หลุดโลกหรืออันตรายได้

ตารางเปรียบเทียบเชิงมวยในการแก้ Secondary ConflictคุณสมบัติGeometric ApproachAI / Machine Learning (DRL)ความแม่นยำทางคณิตศาสตร์สูงมาก (พิสูจน์ได้)เป็นการประมาณการเชิงสถิติ / ค่า Rewardการจัดการน่านฟ้าหนาแน่นต่ำ (มักเกิด Deadlock หรือหาทางออกไม่ได้)สูงมาก (ฉลาดในการแทรกตัวตามช่องว่าง)มิติการแก้ปัญหามักจำกัดที่ 2D (แนวราบ) หรือ 3Dรองรับ 4D (ราบ + ดิ่ง + เวลา) ได้ดีกว่าเวลาในการประมวลผลสม่ำเสมอและเร็วมากในเคสขนาดเล็กขึ้นอยู่กับขนาดของโครงข่ายประสาทเทียมความน่าเชื่อถือในอุตสาหกรรมได้รับการรับรองและใช้งานจริงแล้วอยู่ในขั้นวิจัยและทดสอบในระบบจำลอง (Simulation)สรุปแนวโน้มการใช้งานในปัจจุบันในระบบ ATC ยุคใหม่ (เช่น โครงการ SESAR ของยุโรป หรือ NextGen ของสหรัฐฯ) นิยมใช้ระบบ Hybrid Approach ครับ โดยให้ AI/Optimization Algorithm ทำหน้าที่เป็นผู้คิดไอเดียเส้นทางหลบหลีกที่ซับซ้อนในระยะยาว (Medium-Term หลบลำที่ 2 และ 3 ล่วงหน้า 15 นาที) จากนั้นจะส่งต่อเส้นทางนั้นให้ Geometric Algorithm ทำการตรวจสอบความปลอดภัยขั้นสุดท้าย (Safety Sanity Check) ในระยะสั้น เพื่อให้มั่นใจว่าจะไม่มีข้อผิดพลาดทางเทคนิคเกิดขึ้นจริงครับ

Open-source Simulator เพื่อนำมาวิจัย ทดสอบ หรือพัฒนาอัลกอริทึมแก้ปัญหา Conflict Resolution (ทั้งแบบ Geometric และ AI/ML) เครื่องมือจำลองน่านฟ้าแบบเปิดที่เป็นที่นิยมอย่างมากในแวดวงวิชาการและการบินมีดังนี้ครับ โดยแต่ละตัวจะมีความเด่นและเหมาะกับโจทย์ที่ต่างกันไป:1. BlueSky (โดย TU Delft) — ดีที่สุดสำหรับงานวิจัยภาพรวมและการบินทั่วไปBlueSky Open Air Traffic Simulator พัฒนาโดย Delft University of Technology เป็นหนึ่งในเครื่องมือที่เป็นมาตรฐานที่สุดสำหรับงานวิจัยระบบ ATM (Air Traffic Management)ภาษาที่ใช้: Pythonทำไมถึงเหมาะกับงานนี้:มันออกแบบมาเพื่อเป็นเครื่องมือทดสอบอัลกอริทึม CD&R (Conflict Detection & Resolution) โดยเฉพาะมีระบบตรวจจับ Conflict และฟังก์ชันช่วยหลบหลีกพื้นฐานมาให้ในตัวขยายระบบ (Extendable) ได้ง่ายมากผ่านปลั๊กอิน เหมาะแก่การเขียนโค้ดเพื่อใส่อัลกอริทึมเรขาคณิตหรือเรียกใช้ไลบรารี AI (เช่น PyTorch/TensorFlow) เข้าไปควบคุมเครื่องบินใช้โมเดลประสิทธิภาพเครื่องบินที่แม่นยำ (เช่น BADA หรือ OpenAP) ทำให้การคำนวณอัตราเร่งหรือการเลี้ยวสมจริง