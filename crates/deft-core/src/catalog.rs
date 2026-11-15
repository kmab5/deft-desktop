// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    id,
    model::{normalized, Author, Book, Category, CategoryType, Member, State},
    now,
};
use anyhow::{anyhow, bail, ensure, Result};
use serde_json::Value;

pub fn book<'a>(state: &'a State, book_id: &str) -> Result<&'a Book> {
    state
        .books
        .iter()
        .find(|book| book.id == book_id)
        .ok_or_else(|| anyhow!("Book not found."))
}
pub fn book_mut<'a>(state: &'a mut State, book_id: &str) -> Result<&'a mut Book> {
    state
        .books
        .iter_mut()
        .find(|book| book.id == book_id)
        .ok_or_else(|| anyhow!("Book not found."))
}
pub fn category_mut<'a>(state: &'a mut State, category_id: &str) -> Result<&'a mut Category> {
    state
        .categories
        .iter_mut()
        .find(|category| category.id == category_id)
        .ok_or_else(|| anyhow!("Category not found."))
}

pub fn rating(value: &Value) -> Result<Option<f64>> {
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_f64()
        .ok_or_else(|| anyhow!("Choose a half-star rating."))?;
    ensure!(
        (0.5..=5.0).contains(&value) && (value * 2.0).fract() == 0.0,
        "Choose a rating between half a star and five stars."
    );
    Ok(Some(value))
}

pub fn populate_series(state: &mut State) {
    if state.settings["seriesAutoFill"].as_bool() == Some(false) {
        return;
    }
    let time = now();
    for book in state
        .books
        .iter()
        .filter(|book| !book.ignored && !book.missing)
    {
        let Some(series) = book
            .series
            .as_ref()
            .filter(|series| !series.trim().is_empty())
        else {
            continue;
        };
        let key = normalized(series);
        if state
            .series_dismissed
            .contains(&(key.clone(), book.id.clone()))
        {
            continue;
        }
        let alias = state.series_aliases.get(&key);
        let category_index = state
            .categories
            .iter()
            .position(|category| {
                alias.is_some_and(|id| id == &category.id)
                    || (category.auto_created
                        && normalized(&category.name) == key
                        && category.type_ids.iter().any(|id| id == "series"))
            })
            .unwrap_or_else(|| {
                state.categories.push(Category {
                    id: id(),
                    name: series.clone(),
                    type_ids: vec!["series".into()],
                    auto_created: true,
                    order_mode: "manual".into(),
                    created_at: time,
                    ..Category::default()
                });
                state.categories.len() - 1
            });
        let category = &mut state.categories[category_index];
        if category
            .members
            .iter()
            .any(|member| member.book_id == book.id)
        {
            continue;
        }
        category.members.push(Member {
            book_id: book.id.clone(),
            position: book.series_index.unwrap_or_else(|| next_position(category)),
            suggested: true,
            added_at: time,
        });
    }
}

fn next_position(category: &Category) -> f64 {
    category
        .members
        .iter()
        .map(|member| member.position)
        .fold(0.0, f64::max)
        + 1.0
}

pub fn create_category(
    state: &mut State,
    name: &str,
    description: &str,
    type_ids: Vec<String>,
) -> Result<Category> {
    let name = name.trim();
    ensure!(!name.is_empty(), "Enter a category name.");
    validate_types(state, &type_ids)?;
    let category = Category {
        id: id(),
        name: name.into(),
        description: description.trim().into(),
        type_ids,
        order_mode: "manual".into(),
        created_at: now(),
        ..Category::default()
    };
    state.categories.push(category.clone());
    Ok(category)
}

pub fn validate_types(state: &State, types: &[String]) -> Result<()> {
    ensure!(
        types
            .iter()
            .all(|id| state.types.iter().any(|kind| kind.id == *id)),
        "Category type not found."
    );
    Ok(())
}

pub fn set_type(state: &mut State, type_id: Option<&str>, name: &str) -> Result<CategoryType> {
    let name = name.trim();
    ensure!(!name.is_empty(), "Enter a type name.");
    ensure!(
        !state
            .types
            .iter()
            .any(|kind| Some(kind.id.as_str()) != type_id
                && normalized(&kind.name) == normalized(name)),
        "A category type with that name already exists."
    );
    if let Some(id) = type_id {
        let kind = state
            .types
            .iter_mut()
            .find(|kind| kind.id == id)
            .ok_or_else(|| anyhow!("Category type not found."))?;
        ensure!(!kind.built_in, "Series is a built-in type.");
        kind.name = name.into();
        return Ok(kind.clone());
    }
    let kind = CategoryType {
        id: id(),
        name: name.into(),
        built_in: false,
    };
    state.types.push(kind.clone());
    Ok(kind)
}

pub fn remove_type(state: &mut State, type_id: &str) -> Result<()> {
    let kind = state
        .types
        .iter()
        .find(|kind| kind.id == type_id)
        .ok_or_else(|| anyhow!("Category type not found."))?;
    ensure!(!kind.built_in, "Series is a built-in type.");
    state.types.retain(|kind| kind.id != type_id);
    for category in &mut state.categories {
        category.type_ids.retain(|id| id != type_id);
    }
    Ok(())
}

pub fn membership(
    state: &mut State,
    category_id: &str,
    book_ids: &[String],
    action: &str,
    position: Option<f64>,
) -> Result<()> {
    ensure!(
        position.is_none_or(f64::is_finite),
        "Enter a valid position."
    );
    let book_series = book_ids
        .iter()
        .map(|id| book(state, id).map(|book| (id, book.series.clone())))
        .collect::<Result<Vec<_>>>()?;
    let aliases = state.series_aliases.clone();
    let category = category_mut(state, category_id)?;
    let category_key = normalized(&category.name);
    let auto_created = category.auto_created;
    let mut dismiss = vec![];
    for (id, series) in book_series {
        let index = category
            .members
            .iter()
            .position(|member| member.book_id == *id);
        match (action, index) {
            ("remove", Some(index)) => {
                category.members.remove(index);
                if let Some(series) = series {
                    let key = normalized(&series);
                    if auto_created && key == category_key
                        || aliases.get(&key).is_some_and(|id| id == category_id)
                    {
                        dismiss.push((key, id.clone()));
                    }
                }
            }
            ("add" | "edit", Some(index)) => {
                let member = &mut category.members[index];
                if let Some(position) = position {
                    member.position = position;
                }
                member.suggested = false;
            }
            ("add", None) => category.members.push(Member {
                book_id: id.clone(),
                position: position.unwrap_or_else(|| next_position(category)),
                suggested: false,
                added_at: now(),
            }),
            ("remove" | "edit", None) => {}
            _ => bail!("Unknown membership action."),
        }
    }
    state.series_dismissed.extend(dismiss);
    Ok(())
}

pub fn reorder(state: &mut State, category_id: &str, ids: &[String]) -> Result<()> {
    let category = category_mut(state, category_id)?;
    ensure!(
        !category.type_ids.iter().any(|id| id == "series"),
        "Set decimal positions to reorder a series."
    );
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    ensure!(
        unique.len() == ids.len(),
        "The order contains duplicate books."
    );
    let mut position = 1.0;
    for id in ids {
        let member = category
            .members
            .iter_mut()
            .find(|member| member.book_id == *id)
            .ok_or_else(|| anyhow!("This book is outside the category."))?;
        member.position = position;
        position += 1.0;
    }
    for member in category
        .members
        .iter_mut()
        .filter(|member| !unique.contains(&member.book_id))
    {
        member.position = position;
        position += 1.0;
    }
    category.order_mode = "manual".into();
    Ok(())
}

pub fn remove_category(state: &mut State, category_id: &str) -> Result<()> {
    let index = state
        .categories
        .iter()
        .position(|category| category.id == category_id)
        .ok_or_else(|| anyhow!("Category not found."))?;
    let category = state.categories.remove(index);
    for key in state
        .series_aliases
        .iter()
        .filter_map(|(key, value)| (value == category_id).then(|| key.clone()))
        .chain(category.auto_created.then(|| normalized(&category.name)))
    {
        state.series_dismissed.extend(
            category
                .members
                .iter()
                .map(|member| (key.clone(), member.book_id.clone())),
        );
    }
    state.series_aliases.retain(|_, value| value != category_id);
    Ok(())
}

pub fn merge_categories(state: &mut State, source: &str, target: &str) -> Result<()> {
    ensure!(source != target, "Choose two different categories.");
    category_mut(state, target)?;
    let index = state
        .categories
        .iter()
        .position(|category| category.id == source)
        .ok_or_else(|| anyhow!("Category not found."))?;
    let source_category = state.categories.remove(index);
    let target_category = category_mut(state, target)?;
    for kind in source_category.type_ids {
        if !target_category.type_ids.contains(&kind) {
            target_category.type_ids.push(kind);
        }
    }
    for member in source_category.members {
        if !target_category
            .members
            .iter()
            .any(|existing| existing.book_id == member.book_id)
        {
            target_category.members.push(member);
        }
    }
    for value in state
        .series_aliases
        .values_mut()
        .filter(|value| value.as_str() == source)
    {
        *value = target.into();
    }
    if source_category.auto_created {
        state
            .series_aliases
            .insert(normalized(&source_category.name), target.into());
    }
    Ok(())
}

fn author(state: &State, id: &str) -> Result<Author> {
    state
        .authors
        .iter()
        .find(|author| author.id == id)
        .cloned()
        .ok_or_else(|| anyhow!("Author not found."))
}

pub fn rename_author(state: &mut State, id: &str, name: &str) -> Result<()> {
    author(state, id)?;
    let name = name.trim();
    let key = normalized(name);
    ensure!(!key.is_empty(), "Enter an author name.");
    ensure!(
        !state
            .authors
            .iter()
            .any(|author| author.id != id && normalized(&author.name) == key),
        "Another author has this name. Merge their entries to combine them."
    );
    state.author_names.insert(id.into(), name.into());
    state.author_aliases.insert(key, id.into());
    state.rebuild_authors();
    Ok(())
}

pub fn merge_authors(state: &mut State, source_id: &str, target_id: &str) -> Result<()> {
    ensure!(source_id != target_id, "Choose two different authors.");
    let source = author(state, source_id)?;
    let target = author(state, target_id)?;
    for id in state.author_aliases.values_mut() {
        if id == source_id {
            *id = target_id.into();
        }
    }
    state
        .author_aliases
        .insert(source_id.into(), target_id.into());
    state
        .author_aliases
        .insert(normalized(&source.name), target_id.into());
    state.author_names.insert(target_id.into(), target.name);
    state.author_names.remove(source_id);
    state.rebuild_authors();
    Ok(())
}

pub fn forget(state: &mut State, book_id: &str) -> Result<()> {
    book(state, book_id)?;
    state.books.retain(|book| book.id != book_id);
    state.read_throughs.retain(|run| run.book_id != book_id);
    state.sessions.retain(|session| session.book_id != book_id);
    state
        .annotations
        .retain(|annotation| annotation.book_id != book_id);
    state.series_dismissed.retain(|(_, id)| id != book_id);
    for category in &mut state.categories {
        category.members.retain(|member| member.book_id != book_id);
    }
    state.rebuild_authors();
    Ok(())
}
