// Saved schedules are absolute instants. Only the datetime-local control uses wall time.
const duration=48*3600000;
export function examTimestamp(value) {
  const raw=String(value??'').trim();
  if (/^\d{10}(?:\.\d{1,9})?$/.test(raw)) return Math.round(Number(raw)*1000);
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const m=/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,9}))?)?(Z|[+-]\d\d:?\d\d)?$/.exec(raw);
  if(!m) return NaN;
  const [,year,month,day,hour,minute,second]=m;
  const validDay=Number(day)>0 && Number(day)<=new Date(Date.UTC(+year,+month,0)).getUTCDate();
  if (+month<1 || +month>12 || !validDay || +hour>23 || +minute>59 || +(second??0)>59) return NaN;
  const iso=raw.replace(' ','T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const stamp=Date.parse(iso);
  if (!m[8] && new Date(stamp).getHours()!==+hour) return NaN;
  return stamp;
}
export function localExamInput(value) {
  const d=new Date(examTimestamp(value));
  if (!Number.isFinite(d.getTime())) return '';
  const local=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString();
  return local.slice(0,d.getMilliseconds()?23:d.getSeconds()?19:16);
}
export function examSchedule(profile,now) {
  const hasStart=profile.challengeStart!=='' && profile.challengeStart!=null;
  const hasEnd=profile.deadline!=='' && profile.deadline!=null;
  const end=hasEnd?examTimestamp(profile.deadline):null;
  const start=hasStart?examTimestamp(profile.challengeStart):hasEnd?end-duration:Math.floor(now/60000)*60000;
  const cutoff=hasEnd?end:start+duration;
  let issue;
  if(hasStart && !Number.isFinite(start) || profile.examClockVersion && !hasStart) issue='考核开始时间无效，请填写本地日期与时间';
  else if(!Number.isFinite(cutoff) || profile.examClockVersion && !hasEnd) issue='考核截止时间无效，请填写本地日期与时间';
  else if (cutoff<=start) issue='考核截止时间必须晚于开始时间';
  else if (start>now) issue='考核开始时间尚未到达';
  return {start,cutoff,issue};
}
export function initializeExam(profile,now=Date.now()) {
  // Recover an omitted legacy field from the stored partner. An explicitly
  // cleared or malformed field is an unfinished edit and remains blocked.
  if (profile.challengeStart==null && Number.isFinite(examTimestamp(profile.deadline)))
    profile.challengeStart=new Date(examTimestamp(profile.deadline)-duration).toISOString();
  if (profile.deadline==null && Number.isFinite(examTimestamp(profile.challengeStart)))
    profile.deadline=new Date(examTimestamp(profile.challengeStart)+duration).toISOString();
  const {start,cutoff}=examSchedule(profile,now);
  for (const [key,stamp] of [['challengeStart',start],['deadline',cutoff]]) {
    if(Number.isFinite(stamp) && (profile[key] || !profile.examClockVersion))
      profile[key]=new Date(stamp).toISOString();
  }
  if(profile.deadlineBound && examTimestamp(profile.deadlineBound)===cutoff)
    profile.deadlineBound=profile.deadline;
  profile.examClockVersion=1;
}
