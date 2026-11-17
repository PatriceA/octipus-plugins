(function () {
 window.OctipusProfileEditor = function (call, report) {
  var $=function(id){return document.getElementById(id);};
  var current=null, options={environments:[],connections:[]}, discovered=[], refs={}, gitConnection='';
  function guarded(fn){return function(){Promise.resolve().then(fn).catch(function(e){report(e.message);});};}
  function sync(){
   if(!current)return;
   var copy=JSON.parse(JSON.stringify(current));
   copy.repos.forEach(function(r){if(!r.fetch&&gitConnection&&refs[r.path]?.remotePath){r.fetch={connection:gitConnection,remotePath:refs[r.path].remotePath};r.forgeProject=refs[r.path].remotePath.slice(1).replace(/\.git$/,'');}if(r.fetch){if(gitConnection)r.fetch.connection=gitConnection;else delete r.fetch;}});
   $('profile-json').value=JSON.stringify(copy,null,2);
  }
  function fields(box, defs, data, changed){window.OctipusFields(box,defs,data,function(v){changed(v);sync();});}
  function render(){
   if(!current)return;
   $('guided-profile').hidden=false;
   var env=options.environments.find(function(e){return e.id===current.environmentId;});
   var environments=options.environments.map(function(e){return {value:e.id,label:e.name};});
   if(current.environmentId&&!env)environments.push({value:current.environmentId,label:'Saved environment'});
   fields($('profile-basics'),[{key:'name',label:'Profile name',required:true},{key:'environmentId',label:'Runs in',options:environments},{key:'workspaceRoot',label:'Repository folder',options:env?env.roots:current.workspaceRoot?[current.workspaceRoot]:[]}],current,function(v){
    var changed=v.environmentId!==current.environmentId||v.workspaceRoot!==current.workspaceRoot;
    var environmentChanged=v.environmentId!==current.environmentId;
    current.name=v.name;current.environmentId=v.environmentId;current.workspaceRoot=environmentChanged?(options.environments.find(function(e){return e.id===v.environmentId;})?.roots[0]||''):v.workspaceRoot;
    if(changed){discovered=[];refs={};render();report('Repository location changed. Review existing repository mappings or remove them before saving.');}
   });
   var tracker={connection:current.tracker.connection,projects:current.ticketProjects.join(', '),versionFormat:current.tracker.versionFormat,gitConnection:gitConnection,forge:current.forge?current.forge.connection:''};
   fields($('profile-services'),[{key:'connection',label:'Issue tracker connection',options:options.connections},{key:'projects',label:'Project keys',help:'Comma separated, for example ABC.'},{key:'versionFormat',label:'Tracker version naming',help:'Use {product} and {version}, for example {product}: v.{version}.'},{key:'gitConnection',label:'Git connection (for fresh audit refs)',options:options.connections},{key:'forge',label:'Merge request API (optional)',options:options.connections}],tracker,function(v){
    current.tracker.connection=v.connection;current.ticketProjects=v.projects.split(',').map(function(x){return x.trim();}).filter(Boolean);current.tracker.versionFormat=v.versionFormat;gitConnection=v.gitConnection;
    if(v.forge)current.forge={kind:'gitlab',connection:v.forge,mrTargets:['release']};else delete current.forge;
   });
   var box=$('profile-repositories');box.textContent='';
   current.repos.forEach(function(repo){
    var section=document.createElement('section');section.className='panel guided-fields';var heading=document.createElement('h3');heading.textContent=repo.path;section.append(heading);
    var data={product:repo.product,source:repo.source,release:repo.release,baseline:repo.baseline.tag||'',version:(current.targetVersions||{})[repo.product]||''};
    var choices=refs[repo.path]||{branches:[repo.source,repo.release].filter(Boolean),tags:repo.baseline.tag?[repo.baseline.tag]:[]};
    fields(section,[{key:'product',label:'Product name',help:'Repositories of the same product share a target version.'},{key:'source',label:'Source branch',options:choices.branches},{key:'release',label:'Release branch',options:choices.branches},{key:'baseline',label:'Previous release tag',options:choices.tags},{key:'version',label:'Target version'}],data,function(v){
     repo.product=v.product;repo.source=v.source;repo.release=v.release;repo.baseline={tag:v.baseline};
     if(!current.targetVersions)current.targetVersions={};if(v.version)current.targetVersions[v.product]=v.version;else delete current.targetVersions[v.product];
     var products=new Set(current.repos.map(function(r){return r.product;}));Object.keys(current.targetVersions).forEach(function(p){if(!products.has(p))delete current.targetVersions[p];});
    });
    var remove=document.createElement('button');remove.type='button';remove.textContent='Remove repository';remove.addEventListener('click',function(){current.repos=current.repos.filter(function(r){return r!==repo;});sync();render();});section.append(remove);box.append(section);
   });
   var picker=$('repository-picker');picker.textContent='';
   discovered.filter(function(r){return !current.repos.some(function(saved){return saved.path===r.relative;});}).forEach(function(r){var option=document.createElement('option');option.value=r.path;option.textContent=r.name;picker.append(option);});
   sync();
  }
  async function choices(){options=await call('profile_resources',{});options.environments=options.environments||[];options.connections=options.connections||[];}
  $('new-profile').addEventListener('click',guarded(async function(){
   await choices();var env=options.environments[0];
   current={id:'profile-'+Date.now().toString(36),name:'',environmentId:env?env.id:'',workspaceRoot:env&&env.roots[0]||'',ticketProjects:[],tracker:{connection:'',kind:'jira-cloud',versionFormat:'{product}: v.{version}',doneStatuses:['Done'],parentCarriesVersion:true},manifestFiles:['package.json','package-lock.json','pom.xml','**/pom.xml'],repos:[]};
   gitConnection='';render();
  }));
  $('refresh-profile-options').addEventListener('click',guarded(async function(){await choices();render();}));
  $('find-repositories').addEventListener('click',guarded(async function(){
   if(!current||!current.environmentId||!current.workspaceRoot)throw Error('Choose an environment and repository folder first.');
   var result=await call('profile_resources',{environmentId:current.environmentId,root:current.workspaceRoot});
   discovered=result.repositories.map(function(r){return Object.assign({},r,{relative:r.path===current.workspaceRoot?'.':r.path.slice(current.workspaceRoot.replace(/\/$/,'').length+1)});});render();
   if(result.hidden)report('Some folders are hidden by your access rules.');
   if(result.truncated)report('Only the first 250 folders were scanned. Choose a more specific approved folder for the rest.');
   if(!discovered.length)report('No Git repositories were found in this folder. Select the folder containing your repository directories.');
  }));
  $('add-repository').addEventListener('click',guarded(async function(){
   var selected=discovered.find(function(r){return r.path===$('repository-picker').value;});if(!selected)throw Error('Find and choose a repository first.');
   var info=await call('profile_resources',{environmentId:current.environmentId,root:current.workspaceRoot,repository:selected.path});refs[selected.relative]=info;
   var key=selected.name.replace(/[^A-Za-z0-9_.-]/g,'-').slice(0,55);if(current.repos.some(function(r){return r.key===key;}))key+='-'+(current.repos.length+1);
   current.repos.push({key:key,path:selected.relative,product:key,source:info.branches.includes('develop')?'develop':info.branches.includes('main')?'main':info.branches[0]||'',release:'',baseline:{tag:''},...(info.remotePath&&gitConnection?{fetch:{connection:gitConnection,remotePath:info.remotePath},forgeProject:info.remotePath.slice(1).replace(/\.git$/,'')}: {})});
   render();if(info.truncated)report('Some older references are not listed. Use advanced configuration if you need an unlisted ref.');
  }));
  return {load:function(profile){current=JSON.parse(JSON.stringify(profile));gitConnection=current.repos.find(function(r){return r.fetch;})?.fetch.connection||'';render();},update:function(){sync();}};
 };
}());
