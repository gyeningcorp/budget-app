export const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
export const parseDay = s => new Date(`${s}T12:00:00`)
const nth = (y,m,day,n) => new Date(y,m,1 + (day-new Date(y,m,1).getDay()+7)%7 + (n-1)*7)
const shift = (d,n) => new Date(d.getFullYear(),d.getMonth(),d.getDate()+n)
export function easter(y) {
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),v=h+l-7*m+114
  return new Date(y,Math.floor(v/31)-1,v%31+1)
}
// Federal rules: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/
export function holidays(year) {
  const out=[]
  const add=(title,date,kind='Holiday')=>out.push({id:`holiday-${title}-${dateKey(date)}`,title,date:dateKey(date),kind,holiday:true})
  // Adjacent years include observed New Year's Day falling in December.
  for(let y=year-1;y<=year+1;y++) {
    const fixed=[[0,1,"New Year's Day"],[5,19,'Juneteenth'],[6,4,'Independence Day'],[10,11,'Veterans Day'],[11,25,'Christmas Day']]
    for(const [m,d,title] of fixed){const day=new Date(y,m,d);add(title,day,'Federal holiday');if(day.getDay()===6)add(`${title} (observed)`,shift(day,-1),'Federal holiday');if(day.getDay()===0)add(`${title} (observed)`,shift(day,1),'Federal holiday')}
    for(const [m,w,n,title] of [[0,1,3,'Martin Luther King Jr. Day'],[1,1,3,"Washington’s Birthday / Presidents’ Day"],[8,1,1,'Labor Day'],[9,1,2,'Columbus Day / Indigenous Peoples’ Day'],[10,4,4,'Thanksgiving']])add(title,nth(y,m,w,n),'Federal holiday')
    const may=new Date(y,4,31);add('Memorial Day',shift(may,-(may.getDay()+6)%7),'Federal holiday')
    for(const [m,d,title] of [[1,14,"Valentine’s Day"],[2,17,"St. Patrick’s Day"],[9,31,'Halloween'],[11,24,'Christmas Eve'],[11,31,"New Year’s Eve"]])add(title,new Date(y,m,d),'Occasion')
    add('Mother’s Day',nth(y,4,0,2),'Occasion');add('Father’s Day',nth(y,5,0,3),'Occasion');add('Grandparents Day',shift(nth(y,8,1,1),6),'Occasion')
    const e=easter(y);add('Easter Sunday',e,'Christian observance');add('Good Friday',shift(e,-2),'Christian observance');add('Palm Sunday',shift(e,-7),'Christian observance');add('Ash Wednesday',shift(e,-46),'Christian observance');add('Pentecost',shift(e,49),'Christian observance')
  }
  return out.filter(e=>e.date.startsWith(String(year))).sort((a,b)=>a.date.localeCompare(b.date))
}
export function eventsForYear(events,year) {
 return events.flatMap(e=> {if(e.repeat!=='Yearly')return e.date.startsWith(String(year))?[e]:[]; if(Number(e.date.slice(0,4))>year)return [];const date=`${year}${e.date.slice(4)}`;return dateKey(parseDay(date))===date?[{...e,date}]:[]})
}
export const IDEAS = [
 ['Coffee & a walk','Date night','Free / low cost','Take a thermos to a favorite park and leave time to talk.'],
 ['Dinner after bedtime','Date night','At home','Cook a favorite meal together and turn off your phones.'],
 ['Paint each other’s portrait','Date night','At home','Use supplies you already own; reveal your paintings together.'],
 ['Dreams & dessert','Date night','At home','Share dessert and choose one family goal for the next month.'],
 ['Museum afternoon','Family outing','Paid','Check local hours, admission and family discounts before booking.'],
 ['Library story time','Family outing','Free / low cost','Check your local library calendar for an age-appropriate session.'],
 ['Park picnic','Family outing','Free / low cost','Pack lunch, bubbles and a blanket for an easy afternoon.'],
 ['Living room campout','Family outing','At home','Build a blanket tent, read stories and make a simple snack.'],
 ['Holiday lights walk','Seasonal','Free / low cost','Choose a nearby neighborhood and take hot chocolate.'],
 ['Bake & share','Seasonal','At home','Bake together and prepare a small treat for someone you know.'],
 ['Pumpkin decorating','Seasonal','At home','Use washable paint and let the children design their pumpkins.'],
 ['Family gratitude evening','Faith & service','At home','Share what you are thankful for, pray and write down a memory.'],
 ['Community service day','Faith & service','Free / low cost','Ask a local church about a family-friendly volunteer opportunity.'],
 ['Spring garden project','Family outing','At home','Plant herbs in a pot and let everyone help with watering.'],
].map(([title,kind,cost,notes],i)=>({id:`idea-${i}`,title,kind,cost,notes}))
