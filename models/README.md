# Demucs Model Files

Download these model files and place them in this directory:

```bash
curl -L -o 955717e8-8726e21a.th https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th
curl -L -o 5c90dfd2-34c22ccb.th https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th
```

Then set up Git LFS to track them:

```bash
git lfs install
git lfs track "*.th"
git add .gitattributes models/
git commit -m "Add Demucs models"
git push
```
