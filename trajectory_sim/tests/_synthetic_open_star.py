"""A synthetic OPEN-STAR arrival at VYYY (Yangon), for the vector-to-final tests.

Every published VY STAR is *closed* — it ends on a fix (IF/TF legs only), so no
real Myanmar arrival exercises the open-STAR code path: a STAR whose last leg is
a VM ("fly heading, expect radar vectors") that the controller then turns onto
final (see :mod:`trajectory_sim.vectors`). That code is data-driven and stays;
this module supplies the data it needs, entirely made up but laid out around
VYYY's real runway 03/21 so the geometry is realistic:

* six open STARs — ``OPNE1C``/``OPNN1C``/``OPNW1C``/``OPNS1C`` for RW21 (hand
  over at YS501/YS502 on a published heading of 034°M, a north-east downwind)
  and ``OPNN1D``/``OPNE1D`` for RW03 (hand over at YS503/YS504 on 214°M);
* two straight-in RNP approaches on the extended centrelines — ``R21-V``
  (IAF YS720 20 NM out, YS715 15 NM, IF YS710 10 NM, FAF YS705, MAPt YS700 on
  the RW21 threshold) and ``R03-V`` (YS620, IF YS610, FAF YS605, YS603, MAPt
  YS600 on the RW03 threshold).

All idents are ``YS…`` so they cannot collide with the real VY data (none
begin with ``YS``); the enroute-entry fixes are YS301–YS317. The rows follow
the DFD waypoint schema of ``aixm_vy/star_waypoint.geojson`` /
``pbn_waypoint.geojson``, and :func:`build_navdata` folds them into copies of
the real VY sources, so the real (closed) VYYY STARs and approaches stay
available alongside.
"""

from __future__ import annotations

import json
from pathlib import Path

from trajectory_sim.navdata import NavData, RunwayEnd

#: The RW03 landing threshold this fixture's R03-V approach is built on. The
#: real VYYY RW03 threshold is ~0.3 NM away; the tests register this one in its
#: place so the approach's MAPt sits exactly on the threshold.
RW03_THRESHOLD = RunwayEnd(
    icao="VYYY", ident="RW03", lat=16.893452, lon=96.12396,
    magnetic_bearing=34.0, true_bearing=33.0,
)

# (kind, procedure, route_type, transition, seqno, ident, lat, lon,
#  path_termination, desc_code, magnetic_course, alt_desc, alt1, alt2,
#  speed_limit, speed_limit_desc, turn_direction)
_ROWS = [
    ('STAR', 'OPNS1C', '4', 'YS311', 10, 'YS311', 15.685789, 96.431891, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS311', 20, 'YS401', 16.466273, 96.455494, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '4', 'YS312', 10, 'YS312', 16.606901, 97.692348, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS312', 20, 'YS315', 16.391003, 96.840081, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS312', 30, 'YS401', 16.466273, 96.455494, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '4', 'YS313', 10, 'YS313', 15.877743, 96.035553, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS313', 20, 'YS401', 16.466273, 96.455494, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '4', 'YS314', 10, 'YS314', 16.505748, 97.574089, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS314', 20, 'YS315', 16.391003, 96.840081, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS314', 30, 'YS401', 16.466273, 96.455494, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '4', 'YS315', 10, 'YS315', 16.391003, 96.840081, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS315', 20, 'YS401', 16.466273, 96.455494, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '4', 'YS316', 10, 'YS316', 15.97854, 96.961424, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS316', 20, 'YS401', 16.466273, 96.455494, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '4', 'YS317', 10, 'YS317', 15.772138, 96.721917, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '4', 'YS317', 20, 'YS401', 16.466273, 96.455494, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '5', None, 10, 'YS401', 16.466273, 96.455494, 'IF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNS1C', '5', None, 20, 'YS402', 16.622077, 96.184041, 'TF', 'E', None, '+', 11000.0, None, None, None, None),
    ('STAR', 'OPNS1C', '5', None, 30, 'YS403', 16.775875, 96.144177, 'TF', 'E', None, None, None, None, 250.0, '-', None),
    ('STAR', 'OPNS1C', '5', None, 40, 'YS404', 16.839388, 96.188062, 'TF', 'E', None, 'B', 11000.0, 9000.0, None, None, None),
    ('STAR', 'OPNS1C', '5', None, 50, 'YS405', 17.019169, 96.312502, 'TF', 'E', None, None, None, None, 220.0, '-', None),
    ('STAR', 'OPNS1C', '5', None, 60, 'YS406', 17.087965, 96.360167, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNS1C', '5', None, 70, 'YS501', 17.158908, 96.409411, 'TF', 'E', None, '+', 5000.0, None, None, None, None),
    ('STAR', 'OPNS1C', '6', 'RW21', 10, 'YS501', 17.158908, 96.409411, 'IF', 'E', None, '+', 5000.0, None, None, None, None),
    ('STAR', 'OPNS1C', '6', 'RW21', 20, None, None, None, 'VM', None, 34.0, None, None, None, None, None, None),
    ('STAR', 'OPNW1C', '4', 'YS307', 10, 'YS307', 17.276179, 95.203548, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNW1C', '4', 'YS307', 20, 'YS408', 17.818257, 95.707289, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNW1C', '4', 'YS308', 10, 'YS308', 17.778455, 95.087544, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNW1C', '4', 'YS308', 20, 'YS408', 17.818257, 95.707289, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNW1C', '4', 'YS309', 10, 'YS309', 17.901285, 95.574016, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNW1C', '4', 'YS309', 20, 'YS408', 17.818257, 95.707289, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNW1C', '4', 'YS310', 10, 'YS310', 18.017673, 95.202814, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNW1C', '4', 'YS310', 20, 'YS408', 17.818257, 95.707289, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNW1C', '5', None, 10, 'YS408', 17.818257, 95.707289, 'IF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNW1C', '5', None, 20, 'YS409', 17.745767, 95.823426, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNW1C', '5', None, 30, 'YS410', 17.664789, 95.952928, 'TF', 'E', None, 'B', 15000.0, 14000.0, None, None, None),
    ('STAR', 'OPNW1C', '5', None, 40, 'YS411', 17.592401, 96.068486, 'TF', 'E', None, None, None, None, 250.0, '-', None),
    ('STAR', 'OPNW1C', '5', None, 50, 'YS412', 17.481858, 96.244573, 'TF', 'E', None, '+', 11000.0, None, None, None, None),
    ('STAR', 'OPNW1C', '5', None, 60, 'YS413', 17.259125, 96.093309, 'TF', 'E', None, '+', 9000.0, None, 220.0, '-', None),
    ('STAR', 'OPNW1C', '5', None, 70, 'YS414', 17.194149, 96.194737, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNW1C', '5', None, 80, 'YS502', 17.264152, 96.242424, 'TF', 'E', None, '+', 6000.0, None, None, None, 'L'),
    ('STAR', 'OPNW1C', '6', 'RW21', 10, 'YS502', 17.264152, 96.242424, 'IF', 'E', None, '+', 6000.0, None, None, None, None),
    ('STAR', 'OPNW1C', '6', 'RW21', 20, None, None, None, 'VM', None, 34.0, None, None, None, None, None, None),
    ('STAR', 'OPNN1C', '4', 'YS303', 10, 'YS303', 17.837161, 96.753675, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1C', '4', 'YS303', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1C', '4', 'YS304', 10, 'YS304', 18.568571, 96.229412, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1C', '4', 'YS304', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1C', '4', 'YS305', 10, 'YS305', 18.453034, 96.586618, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1C', '4', 'YS305', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1C', '4', 'YS306', 10, 'YS306', 18.223261, 96.069534, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1C', '4', 'YS306', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1C', '5', None, 10, 'YS415', 17.934372, 96.370382, 'IF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1C', '5', None, 20, 'YS416', 17.786295, 96.36478, 'TF', 'E', None, '+', 16000.0, None, None, None, None),
    ('STAR', 'OPNN1C', '5', None, 30, 'YS417', 17.650861, 96.359675, 'TF', 'E', None, None, None, None, 250.0, '-', None),
    ('STAR', 'OPNN1C', '5', None, 40, 'YS412', 17.481858, 96.244573, 'TF', 'E', None, '+', 11000.0, None, None, None, None),
    ('STAR', 'OPNN1C', '5', None, 50, 'YS413', 17.259125, 96.093309, 'TF', 'E', None, '+', 9000.0, None, 220.0, '-', None),
    ('STAR', 'OPNN1C', '5', None, 60, 'YS414', 17.194149, 96.194737, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1C', '5', None, 70, 'YS502', 17.264152, 96.242424, 'TF', 'E', None, '+', 6000.0, None, None, None, 'L'),
    ('STAR', 'OPNN1C', '6', 'RW21', 10, 'YS502', 17.264152, 96.242424, 'IF', 'E', None, '+', 6000.0, None, None, None, None),
    ('STAR', 'OPNN1C', '6', 'RW21', 20, None, None, None, 'VM', None, 34.0, None, None, None, None, None, None),
    ('STAR', 'OPNE1D', '4', 'YS302', 10, 'YS302', 17.386404, 97.5498, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1D', '4', 'YS302', 20, 'YS418', 17.344343, 96.855647, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNE1D', '4', 'YS301', 10, 'YS301', 17.591851, 97.104476, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1D', '4', 'YS301', 20, 'YS418', 17.344343, 96.855647, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNE1D', '5', None, 10, 'YS418', 17.344343, 96.855647, 'IF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNE1D', '5', None, 20, 'YS419', 17.217597, 96.643394, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1D', '5', None, 30, 'YS420', 17.117044, 96.475516, 'TF', 'E', None, '-', 13000.0, None, 250.0, '-', None),
    ('STAR', 'OPNE1D', '5', None, 40, 'YS405', 17.019169, 96.312502, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1D', '5', None, 50, 'YS421', 16.945196, 96.26126, 'TF', 'E', None, '+', 11000.0, None, None, None, None),
    ('STAR', 'OPNE1D', '5', None, 60, 'YS422', 16.871202, 96.210064, 'TF', 'E', None, None, None, None, 220.0, '-', None),
    ('STAR', 'OPNE1D', '5', None, 70, 'YS423', 16.702406, 96.093457, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1D', '5', None, 80, 'YS504', 16.632822, 96.045363, 'TF', 'E', None, '+', 3000.0, None, None, None, None),
    ('STAR', 'OPNE1D', '6', 'RW03', 10, 'YS504', 16.632822, 96.045363, 'IF', 'E', None, '+', 3000.0, None, None, None, None),
    ('STAR', 'OPNE1D', '6', 'RW03', 20, None, None, None, 'VM', None, 214.0, None, None, None, None, None, None),
    ('STAR', 'OPNE1C', '4', 'YS302', 10, 'YS302', 17.386404, 97.5498, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1C', '4', 'YS302', 20, 'YS418', 17.344343, 96.855647, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNE1C', '4', 'YS301', 10, 'YS301', 17.591851, 97.104476, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1C', '4', 'YS301', 20, 'YS418', 17.344343, 96.855647, 'TF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNE1C', '5', None, 10, 'YS418', 17.344343, 96.855647, 'IF', 'E', None, '-', 18000.0, None, 280.0, '-', None),
    ('STAR', 'OPNE1C', '5', None, 20, 'YS425', 17.173306, 96.56577, 'TF', 'E', None, 'B', 14000.0, 11000.0, 250.0, '-', None),
    ('STAR', 'OPNE1C', '5', None, 30, 'YS426', 17.094001, 96.510677, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1C', '5', None, 40, 'YS427', 17.023058, 96.46146, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1C', '5', None, 50, 'YS428', 16.954241, 96.413744, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1C', '5', None, 60, 'YS405', 17.019169, 96.312502, 'TF', 'E', None, None, None, None, 220.0, '-', None),
    ('STAR', 'OPNE1C', '5', None, 70, 'YS406', 17.087965, 96.360167, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNE1C', '5', None, 80, 'YS501', 17.158908, 96.409411, 'TF', 'E', None, '+', 5000.0, None, None, None, None),
    ('STAR', 'OPNE1C', '6', 'RW21', 10, 'YS501', 17.158908, 96.409411, 'IF', 'E', None, '+', 5000.0, None, None, None, None),
    ('STAR', 'OPNE1C', '6', 'RW21', 20, None, None, None, 'VM', None, 34.0, None, None, None, None, None, None),
    ('STAR', 'OPNN1D', '4', 'YS303', 10, 'YS303', 17.837161, 96.753675, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1D', '4', 'YS303', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 22000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1D', '4', 'YS304', 10, 'YS304', 18.568571, 96.229412, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1D', '4', 'YS304', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 22000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1D', '4', 'YS305', 10, 'YS305', 18.453034, 96.586618, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1D', '4', 'YS305', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 22000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1D', '4', 'YS306', 10, 'YS306', 18.223261, 96.069534, 'IF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1D', '4', 'YS306', 20, 'YS415', 17.934372, 96.370382, 'TF', 'E', None, '-', 22000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1D', '5', None, 10, 'YS415', 17.934372, 96.370382, 'IF', 'E', None, '-', 22000.0, None, 280.0, '-', None),
    ('STAR', 'OPNN1D', '5', None, 20, 'YS429', 17.642392, 96.35936, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1D', '5', None, 30, 'YS430', 17.439315, 96.312258, 'TF', 'E', None, '+', 16000.0, None, None, None, None),
    ('STAR', 'OPNN1D', '5', None, 40, 'YS431', 17.329191, 96.286785, 'TF', 'E', None, None, None, None, 250.0, '-', None),
    ('STAR', 'OPNN1D', '5', None, 50, 'YS432', 17.161229, 96.172326, 'TF', 'E', None, '+', 11000.0, None, None, None, None),
    ('STAR', 'OPNN1D', '5', None, 60, 'YS433', 16.976028, 96.046437, 'TF', 'E', None, 'B', 9000.0, 7000.0, 220.0, '-', None),
    ('STAR', 'OPNN1D', '5', None, 70, 'YS434', 16.804947, 95.93044, 'TF', 'E', None, None, None, None, None, None, None),
    ('STAR', 'OPNN1D', '5', None, 80, 'YS503', 16.734855, 95.882995, 'TF', 'E', None, '+', 4000.0, None, None, None, None),
    ('STAR', 'OPNN1D', '6', 'RW03', 10, 'YS503', 16.734855, 95.882995, 'IF', 'E', None, '+', 4000.0, None, None, None, None),
    ('STAR', 'OPNN1D', '6', 'RW03', 20, None, None, None, 'VM', None, 214.0, None, None, None, None, None, None),
    ('APPROACH', 'R21-V', 'A', 'YS720', 10, 'YS720', 17.204201, 96.33465, 'IF', 'E  A', None, '+', 4000.0, None, 220.0, '-', None),
    ('APPROACH', 'R21-V', 'A', 'YS720', 30, 'YS715', 17.134137, 96.28707, 'TF', 'E', None, '+', 2500.0, None, None, None, None),
    ('APPROACH', 'R21-V', 'R', None, 10, 'YS715', 17.134137, 96.28707, 'IF', 'E  I', None, '+', 2500.0, None, None, None, None),
    ('APPROACH', 'R21-V', 'R', None, 15, 'YS710', 17.064064, 96.239525, 'TF', 'E', 214.0, '+', 2000.0, None, 180.0, '@', None),
    ('APPROACH', 'R21-V', 'R', None, 20, 'YS705', 16.992014, 96.190691, 'TF', 'E  F', 214.0, '@', 1600.0, None, None, None, None),
    ('APPROACH', 'R21-V', 'R', None, 30, 'YS700', 16.923736, 96.144456, 'TF', 'EY M', 214.0, '@', 93.0, None, None, None, None),
    ('APPROACH', 'R21-V', 'R', None, 40, 'YS699', 16.893452, 96.12396, 'CF', 'EY', 214.0, None, None, None, None, None, None),
    ('APPROACH', 'R21-V', 'R', None, 50, 'YS731', 16.836592, 96.136422, 'DF', 'E', None, None, None, None, 210.0, '-', None),
    ('APPROACH', 'R21-V', 'R', None, 60, 'YS732', 16.882581, 96.365716, 'TF', 'E', None, '-', 4000.0, None, None, None, None),
    ('APPROACH', 'R21-V', 'R', None, 70, 'YS733', 17.023668, 96.462071, 'TF', 'E', None, '+', 5000.0, None, None, None, None),
    ('APPROACH', 'R21-V', 'R', None, 80, 'YS733', 17.023668, 96.462071, 'HM', 'E  H', 34.0, '+', 5000.0, None, 230.0, '-', 'R'),
    ('APPROACH', 'R03-V', 'A', 'YS620', 10, 'YS620', 16.676056, 95.977068, 'IF', 'E  A', None, '+', 3000.0, None, 220.0, '-', None),
    ('APPROACH', 'R03-V', 'A', 'YS620', 20, 'YS610', 16.746197, 96.024417, 'TF', 'E', None, '+', 2000.0, None, 180.0, '@', None),
    ('APPROACH', 'R03-V', 'R', None, 10, 'YS610', 16.746197, 96.024417, 'IF', 'E  I', None, '+', 2000.0, None, 180.0, '@', None),
    ('APPROACH', 'R03-V', 'R', None, 20, 'YS605', 16.825151, 96.077788, 'TF', 'E  F', 34.0, '@', 1600.0, None, None, None, None),
    ('APPROACH', 'R03-V', 'R', None, 25, 'YS603', 16.851674, 96.095695, 'TF', 'E', 34.0, '+', 1000.0, None, None, None, None),
    ('APPROACH', 'R03-V', 'R', None, 30, 'YS600', 16.893452, 96.12396, 'TF', 'EY M', 34.0, '@', 160.0, None, None, None, None),
    ('APPROACH', 'R03-V', 'R', None, 40, 'YS599', 16.923736, 96.144456, 'CF', 'EY', 34.0, None, None, None, None, None, None),
    ('APPROACH', 'R03-V', 'R', None, 50, 'YS631', 16.950557, 96.228592, 'DF', 'E', None, None, None, None, 210.0, '-', None),
    ('APPROACH', 'R03-V', 'R', None, 60, 'YS632', 16.869599, 96.356718, 'TF', 'E', None, '-', 3000.0, None, None, None, None),
    ('APPROACH', 'R03-V', 'R', None, 70, 'YS633', 16.637257, 96.198674, 'TF', 'E', None, '+', 4000.0, None, None, None, None),
    ('APPROACH', 'R03-V', 'R', None, 80, 'YS633', 16.637257, 96.198674, 'HM', 'E  H', 214.0, '+', 4000.0, None, 230.0, '-', 'L'),
]


def _features(kind: str, airport: str = "VYYY") -> list[dict]:
    out = []
    for (k, proc, rt, tr, seq, ident, lat, lon, pt, desc, mag, alt_d, alt1,
         alt2, spd, spd_d, turn) in _ROWS:
        if k != kind:
            continue
        out.append({
            "type": "Feature",
            "properties": {
                "airport_identifier": airport,
                "procedure_identifier": proc,
                "route_type": rt,
                "transition_identifier": tr,
                "seqno": seq,
                "waypoint_identifier": ident,
                "waypoint_latitude": lat,
                "waypoint_longitude": lon,
                "path_termination": pt,
                "waypoint_description_code": desc,
                "magnetic_course": mag,
                "altitude_description": alt_d,
                "altitude1": alt1,
                "altitude2": alt2,
                "speed_limit": spd,
                "speed_limit_description": spd_d,
                "turn_direction": turn,
            },
            "geometry": (
                None if lat is None
                else {"type": "Point", "coordinates": [lon, lat]}
            ),
        })
    return out


def _merged(real: Path | None, extra: list[dict], out: Path) -> Path:
    fc: dict = {"type": "FeatureCollection", "features": []}
    if real is not None and real.is_file():
        fc = json.loads(real.read_text(encoding="utf-8"))
        fc.pop("crs", None)
    fc["features"] = list(fc.get("features", [])) + extra
    out.write_text(json.dumps(fc), encoding="utf-8")
    return out


def build_navdata(
    tmp_dir: Path,
    *,
    sid_source: Path | None,
    star_source: Path | None,
    approach_source: Path | None,
    ils_source: Path | None,
) -> NavData:
    """A NavData over the real VY sources plus the synthetic open arrivals."""
    return NavData(
        sid_source=sid_source,
        star_source=_merged(star_source, _features("STAR"), tmp_dir / "star.geojson"),
        approach_source=_merged(
            approach_source, _features("APPROACH"), tmp_dir / "pbn.geojson"
        ),
        ils_source=ils_source,
    )
